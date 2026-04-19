import type { ServiceName } from './apiHealth.js';
import {
  recordOutcome, noteFailure, noteSuccess,
  isBreakerOpen, onBreakerTrialResult, tryClaimTrialSlot,
  releaseBreakerTrialSlot,
} from './apiHealth.js';

export type { ServiceName };

export interface HttpRequestOptions {
  timeoutMs?: number;
  maxRetries?: number;
  parseJson?: boolean;
}

export class HttpError extends Error {
  readonly service: ServiceName;
  readonly status?: number;
  readonly attempts: number;
  readonly lastError?: Error;

  constructor(args: {
    service: ServiceName;
    status?: number;
    attempts: number;
    message: string;
    lastError?: Error;
  }) {
    super(args.message);
    this.name = 'HttpError';
    this.service = args.service;
    this.status = args.status;
    this.attempts = args.attempts;
    this.lastError = args.lastError;
  }
}

export class CircuitOpenError extends Error {
  readonly service: ServiceName;
  constructor(service: ServiceName) {
    super(`Circuit open for ${service}`);
    this.name = 'CircuitOpenError';
    this.service = service;
  }
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRY_AFTER_CAP_MS = 30_000;
// NOTE: httpRequest assumes all calls are idempotent. All current callers
// (Raider.io/wowaudit GETs, WarcraftLogs OAuth client_credentials POST and
// GraphQL read queries) are safe to retry. Adding a non-idempotent caller
// in future requires a caller-level opt-out (e.g. `opts.maxRetries = 0`).
export async function httpRequest<T>(
  service: ServiceName,
  url: string,
  init?: RequestInit,
  opts?: HttpRequestOptions,
): Promise<T> {
  if (isBreakerOpen(service)) {
    recordOutcome(service, 'circuit_rejected', {
      msg: `Circuit open for ${service}`,
    });
    throw new CircuitOpenError(service);
  }

  // If state is half_open, atomically claim the single trial slot.
  // tryClaimTrialSlot returns true iff this call is the trial; subsequent
  // concurrent callers see isBreakerOpen === true (trialInFlight=true) and
  // fast-fail at the check above.
  const breakerWasHalfOpen = tryClaimTrialSlot(service);

  try {
    const timeoutMs = opts?.timeoutMs ?? 10_000;
    const maxRetries = opts?.maxRetries ?? 2;
    const parseJson = opts?.parseJson ?? true;

    let attempt = 0;
    let sawRateLimit = false;
    let sawTimeout = false;
    let lastError: Error | undefined;
    let lastStatus: number | undefined;

    while (attempt <= maxRetries) {
      attempt += 1;
      // NOTE: AbortController + setTimeout (rather than AbortSignal.timeout)
      // avoids a fake-timer interaction bug in Node where a fired
      // AbortSignal.timeout prevents subsequent setTimeout-based fake timers
      // from advancing correctly in the same promise chain.
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => {
        abortController.abort();
      }, timeoutMs);
      const signal = init?.signal
        ? AbortSignal.any([init.signal, abortController.signal])
        : abortController.signal;

      let response: Response;
      try {
        response = await fetch(url, { ...init, signal });
      } catch (err) {
        clearTimeout(timeoutId);
        // fetch threw AbortError but we don't know which signal caused it —
        // caller-supplied `init.signal` or our internal timeout. Check
        // init.signal.aborted to distinguish: if the caller aborted, don't
        // retry and don't punish the service; release the trial slot and
        // propagate verbatim.
        if (init?.signal?.aborted) {
          if (breakerWasHalfOpen) releaseBreakerTrialSlot(service);
          throw err;
        }
        const e = asError(err);
        const isTimeout = e.name === 'AbortError' || e.name === 'TimeoutError';
        lastError = e;
        if (isTimeout) sawTimeout = true;

        if (attempt > maxRetries) break;
        await sleep(computeBackoffMs(attempt), init?.signal);
        continue;
      }

      if (response.ok) {
        if (!parseJson) {
          clearTimeout(timeoutId);
          finishSuccess(service, attempt, breakerWasHalfOpen);
          return undefined as T;
        }
        // NOTE: timeoutId is still armed — the timeout must cover body
        // parsing, not just the fetch headers phase. A server that streams
        // headers and hangs on the body would otherwise block indefinitely.
        try {
          const data = (await response.json()) as T;
          clearTimeout(timeoutId);
          finishSuccess(service, attempt, breakerWasHalfOpen);
          return data;
        } catch (err) {
          clearTimeout(timeoutId);
          // Distinguish caller-abort from our timeout. response.json() throws
          // AbortError for either; the flags on the underlying controllers are
          // what tell us which signal fired. Must check the caller signal
          // first — if both are aborted, caller-intent wins.
          if (init?.signal?.aborted) {
            if (breakerWasHalfOpen) releaseBreakerTrialSlot(service);
            throw err;
          }
          if (abortController.signal.aborted) {
            const e = asError(err);
            lastError = e;
            sawTimeout = true;
            if (attempt > maxRetries) break;
            await sleep(computeBackoffMs(attempt), init?.signal);
            continue;
          }
          // Genuine JSON parse error — not transient. Still honor outcome
          // classification in case earlier attempts saw 429 / timeout.
          const e = asError(err);
          recordOutcome(service, classifyFinalFailure(sawRateLimit, sawTimeout), {
            msg: `JSON parse error: ${e.message}`,
          });
          noteFailure(service);
          onFinalFailure(service, breakerWasHalfOpen);
          throw new HttpError({
            service, attempts: attempt, status: response.status,
            message: `${service} JSON parse error: ${e.message}`, lastError: e,
          });
        }
      }

      clearTimeout(timeoutId);
      lastStatus = response.status;
      if (response.status === 429) sawRateLimit = true;

      if (!RETRYABLE_STATUSES.has(response.status)) {
        recordOutcome(service, classifyFinalFailure(sawRateLimit, sawTimeout), {
          msg: `${response.status} ${response.statusText}`,
          status: response.status,
        });
        noteFailure(service);
        onFinalFailure(service, breakerWasHalfOpen);
        throw new HttpError({
          service, attempts: attempt, status: response.status,
          message: `${service} API error: ${response.status} ${response.statusText}`,
        });
      }

      const retryAfterMs = parseRetryAfter(
        response.headers.get('retry-after'),
        response.headers.get('date'),
      );
      if (retryAfterMs !== null && retryAfterMs > RETRY_AFTER_CAP_MS) {
        // Upstream told us to wait longer than our cap; treat as final failure.
        recordOutcome(service, classifyFinalFailure(sawRateLimit, sawTimeout), {
          msg: `Retry-After ${Math.round(retryAfterMs / 1_000)}s exceeds ${RETRY_AFTER_CAP_MS / 1_000}s cap`,
          status: response.status,
        });
        noteFailure(service);
        onFinalFailure(service, breakerWasHalfOpen);
        throw new HttpError({
          service, attempts: attempt, status: response.status,
          message: `${service} Retry-After exceeds ${RETRY_AFTER_CAP_MS / 1_000}s cap`,
        });
      }

      if (attempt > maxRetries) break;
      const waitMs = retryAfterMs !== null ? retryAfterMs : computeBackoffMs(attempt);
      await sleep(waitMs, init?.signal);
    }

    // Exhausted retries.
    const msg = lastError
      ? lastError.message
      : lastStatus !== undefined
      ? `${lastStatus}`
      : 'unknown error';
    recordOutcome(service, classifyFinalFailure(sawRateLimit, sawTimeout), {
      msg,
      status: lastStatus,
    });
    noteFailure(service);
    onFinalFailure(service, breakerWasHalfOpen);
    throw new HttpError({
      service, attempts: attempt, status: lastStatus,
      message: `${service} request failed after ${attempt} attempt(s): ${msg}`,
      lastError,
    });
  } finally {
    // Defense in depth. All normal exit paths already release/resolve the
    // trial slot (finishSuccess → onBreakerTrialResult(true); onFinalFailure
    // → onBreakerTrialResult(false); caller-abort branches →
    // releaseBreakerTrialSlot). releaseBreakerTrialSlot is a no-op unless
    // state is still half_open with trialInFlight=true — so on normal
    // exits this is harmless, and on unexpected throws (signal-aware
    // sleep aborting, internal helper failing, etc.) it prevents the
    // breaker from getting stuck.
    if (breakerWasHalfOpen) releaseBreakerTrialSlot(service);
  }
}

function finishSuccess(service: ServiceName, attempt: number, wasTrial: boolean): void {
  recordOutcome(service, 'ok');
  if (attempt > 1) recordOutcome(service, 'retried');
  noteSuccess(service);
  if (wasTrial) onBreakerTrialResult(service, true);
}

function onFinalFailure(service: ServiceName, wasTrial: boolean): void {
  if (wasTrial) onBreakerTrialResult(service, false);
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

// Outcome precedence for a final failure: if any attempt was rate-limited,
// classify as rate_limited; otherwise if any timed out, timeout; else failed.
// Matches the spec's outcome classification table.
function classifyFinalFailure(
  sawRateLimit: boolean,
  sawTimeout: boolean,
): 'rate_limited' | 'timeout' | 'failed' {
  if (sawRateLimit) return 'rate_limited';
  if (sawTimeout) return 'timeout';
  return 'failed';
}

function parseRetryAfter(header: string | null, serverDateHeader: string | null): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.floor(seconds * 1_000);
  }
  const asDate = Date.parse(trimmed);
  if (!Number.isNaN(asDate)) {
    // Compute the offset against the server's own Date header when present
    // so we're robust to clock skew between this process and the upstream.
    // Fall back to local time if the server didn't provide a Date header.
    const serverNowMs = serverDateHeader ? Date.parse(serverDateHeader) : NaN;
    const referenceMs = Number.isNaN(serverNowMs) ? Date.now() : serverNowMs;
    return Math.max(0, asDate - referenceMs);
  }
  return null;
}

// Signal-aware sleep. Rejects with the signal's reason if aborted.
// We roll our own (rather than timers/promises.setTimeout) because the
// test suite drives backoff via vitest fake timers, which intercept the
// global setTimeout but not the timers/promises variant reliably.
function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  }
  return new Promise((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(id);
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

function computeBackoffMs(attemptJustCompleted: number): number {
  // attemptJustCompleted is 1 after the first attempt, 2 after the second,
  // so exponent is always >= 0. Wait: base * 2^(n-1) + proportional jitter.
  const base = 500;
  const exponent = attemptJustCompleted - 1;
  const computed = base * Math.pow(2, exponent);
  const jitter = Math.random() * (base * Math.pow(2, exponent - 1));
  return Math.floor(computed + jitter);
}


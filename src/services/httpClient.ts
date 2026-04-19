import type { ServiceName } from './apiHealth.js';
import { recordOutcome, noteFailure, noteSuccess } from './apiHealth.js';

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
      ? mergeSignals([init.signal, abortController.signal])
      : abortController.signal;

    let response: Response;
    try {
      response = await fetch(url, { ...init, signal });
      clearTimeout(timeoutId);
    } catch (err) {
      clearTimeout(timeoutId);
      const e = err instanceof Error ? err : new Error(String(err));
      const isTimeout = e.name === 'AbortError' || e.name === 'TimeoutError';
      lastError = e;
      if (isTimeout) sawTimeout = true;

      if (attempt > maxRetries) break;
      await sleep(computeBackoffMs(attempt));
      continue;
    }

    if (response.ok) {
      if (!parseJson) {
        finishSuccess(service, attempt);
        return undefined as T;
      }
      try {
        const data = (await response.json()) as T;
        finishSuccess(service, attempt);
        return data;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        // JSON parse errors are not transient.
        recordOutcome(service, 'failed', { msg: `JSON parse error: ${e.message}` });
        noteFailure(service);
        throw new HttpError({
          service, attempts: attempt,
          message: `${service} JSON parse error: ${e.message}`, lastError: e,
        });
      }
    }

    lastStatus = response.status;
    if (response.status === 429) sawRateLimit = true;

    if (!RETRYABLE_STATUSES.has(response.status)) {
      // Non-retryable HTTP error.
      recordOutcome(service, 'failed', {
        msg: `${response.status} ${response.statusText}`,
        status: response.status,
      });
      noteFailure(service);
      throw new HttpError({
        service, attempts: attempt, status: response.status,
        message: `${service} API error: ${response.status} ${response.statusText}`,
      });
    }

    if (attempt > maxRetries) break;
    await sleep(computeBackoffMs(attempt));
  }

  // Exhausted retries.
  const outcome = sawRateLimit ? 'rate_limited' : sawTimeout ? 'timeout' : 'failed';
  const msg = lastError
    ? lastError.message
    : lastStatus !== undefined
    ? `${lastStatus}`
    : 'unknown error';
  recordOutcome(service, outcome, { msg, status: lastStatus });
  noteFailure(service);
  throw new HttpError({
    service, attempts: attempt, status: lastStatus,
    message: `${service} request failed after ${attempt} attempt(s): ${msg}`,
    lastError,
  });
}

function finishSuccess(service: ServiceName, attempt: number): void {
  recordOutcome(service, 'ok');
  if (attempt > 1) recordOutcome(service, 'retried');
  noteSuccess(service);
}

function computeBackoffMs(attemptJustCompleted: number): number {
  // attemptJustCompleted is 1 after the first attempt, 2 after the second.
  // Backoff waits BEFORE the next attempt: base * 2^(n-1) + jitter(0..base/2).
  const base = 500;
  const exponent = attemptJustCompleted - 1;
  const computed = base * Math.pow(2, exponent);
  const jitter = Math.random() * (base * Math.pow(2, exponent - 1));
  return Math.floor(computed + (exponent >= 0 ? jitter : 0));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Combines an external abort signal with a timeout signal. Aborts when
// either fires.
function mergeSignals(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      controller.abort(s.reason);
      return controller.signal;
    }
    s.addEventListener('abort', () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}

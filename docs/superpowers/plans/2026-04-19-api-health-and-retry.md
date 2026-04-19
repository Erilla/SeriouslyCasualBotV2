# API Health & Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route all external HTTP calls (Raider.io, WarcraftLogs, wowaudit) through a shared client that applies timeouts, retries, exponential backoff, per-service circuit breakers, and records health into an in-memory rolling tracker surfaced through `/status`.

**Architecture:** Two new service modules (`httpClient`, `apiHealth`) compose: `httpClient` owns the request lifecycle and delegates breaker state + outcome recording to `apiHealth`. The three existing service files are refactored to replace `fetch` with `httpRequest`. `/status` gains an "API Health (last hour)" section. User-invoked commands that hit an open breaker get a friendlier message via `interactionCreate`.

**Tech Stack:** TypeScript (strict, ESM, nodenext module resolution), Node 22 native `fetch` + `AbortSignal.timeout`, Vitest with `vi.useFakeTimers()` for time-based tests, Discord.js v14 embed fields.

**Spec:** `docs/superpowers/specs/2026-04-19-api-health-and-retry-design.md`

---

## File Structure

**New files:**
- `src/services/apiHealth.ts` — tracker state + breaker state machine. Exposes `recordOutcome`, `getSummary`, `getAllSummaries`, `isBreakerOpen`, `onBreakerTrialResult`, `noteFailure`, `noteSuccess`, and (for tests only) `__resetForTests`.
- `src/services/httpClient.ts` — `httpRequest<T>` wrapper. Exports `HttpError`, `CircuitOpenError`, `ServiceName` type.
- `tests/unit/apiHealth.test.ts`
- `tests/unit/httpClient.test.ts`

**Modified files:**
- `src/services/raiderio.ts` — 4 `fetch` sites → `httpRequest`.
- `src/services/wowaudit.ts` — 3 `fetch` sites → `httpRequest`.
- `src/services/warcraftlogs.ts` — OAuth POST + GraphQL POST via `httpRequest`; `getTrialLogs` catches `HttpError`/`CircuitOpenError` at its boundary and returns `[]`.
- `src/commands/status.ts` — appends "API Health (last hour)" section.
- `src/events/interactionCreate.ts` — ChatInput error handler adds `CircuitOpenError` branch.
- `tests/unit/raiderio.test.ts` — 5xx single-call assertions updated to expect retries; error-message assertions updated for `HttpError` shape.
- `tests/unit/wowaudit.test.ts` — same updates.

---

## Task 1: apiHealth — tracker core (no breaker yet)

**Files:**
- Create: `src/services/apiHealth.ts`
- Test: `tests/unit/apiHealth.test.ts`

- [ ] **Step 1: Write failing tests for the tracker core**

Create `tests/unit/apiHealth.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  recordOutcome,
  getSummary,
  getAllSummaries,
  __resetForTests,
} from '../../src/services/apiHealth.js';

beforeEach(() => {
  __resetForTests();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-19T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('apiHealth tracker core', () => {
  it('starts with zeroed totals and closed breaker', () => {
    const s = getSummary('raiderio');
    expect(s.totals).toEqual({
      ok: 0, retried: 0, rateLimited: 0, timeouts: 0, failed: 0, circuitRejected: 0,
    });
    expect(s.breaker).toBe('closed');
    expect(s.lastError).toBeUndefined();
  });

  it('accumulates outcomes in the current minute bucket', () => {
    recordOutcome('raiderio', 'ok');
    recordOutcome('raiderio', 'ok');
    recordOutcome('raiderio', 'retried');
    recordOutcome('raiderio', 'failed', { msg: 'boom', status: 500 });

    const s = getSummary('raiderio');
    expect(s.totals.ok).toBe(2);
    expect(s.totals.retried).toBe(1);
    expect(s.totals.failed).toBe(1);
    expect(s.lastError).toEqual({
      msg: 'boom',
      status: 500,
      at: new Date('2026-04-19T12:00:00Z'),
    });
  });

  it('evicts buckets older than 60 minutes', () => {
    recordOutcome('raiderio', 'ok');

    vi.setSystemTime(new Date('2026-04-19T12:59:59Z'));
    expect(getSummary('raiderio').totals.ok).toBe(1);

    vi.setSystemTime(new Date('2026-04-19T13:00:01Z'));
    expect(getSummary('raiderio').totals.ok).toBe(0);
  });

  it('keeps per-service state isolated', () => {
    recordOutcome('raiderio', 'ok');
    recordOutcome('wowaudit', 'failed', { msg: 'x' });

    expect(getSummary('raiderio').totals.ok).toBe(1);
    expect(getSummary('raiderio').totals.failed).toBe(0);
    expect(getSummary('wowaudit').totals.ok).toBe(0);
    expect(getSummary('wowaudit').totals.failed).toBe(1);
  });

  it('getAllSummaries returns an entry per known service', () => {
    const all = getAllSummaries();
    expect(Object.keys(all).sort()).toEqual(['raiderio', 'warcraftlogs', 'wowaudit']);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/apiHealth.test.ts`
Expected: FAIL — module `../../src/services/apiHealth.js` not found.

- [ ] **Step 3: Implement the tracker core**

Create `src/services/apiHealth.ts`:

```ts
export type ServiceName = 'raiderio' | 'warcraftlogs' | 'wowaudit';

export type Outcome =
  | 'ok'
  | 'retried'
  | 'rate_limited'
  | 'timeout'
  | 'failed'
  | 'circuit_rejected';

export type BreakerState = 'closed' | 'half_open' | 'open';

export interface ErrorDetail {
  msg: string;
  status?: number;
}

interface MinuteBucket {
  minuteEpoch: number;
  counts: Record<Outcome, number>;
}

interface ServiceState {
  buckets: MinuteBucket[];
  lastError?: { msg: string; status?: number; at: Date };
  breaker: {
    state: BreakerState;
    openedAt?: Date;
    consecutiveFailures: number;
  };
}

export interface ServiceSummary {
  totals: {
    ok: number;
    retried: number;
    rateLimited: number;
    timeouts: number;
    failed: number;
    circuitRejected: number;
  };
  lastError?: { msg: string; status?: number; at: Date };
  breaker: BreakerState;
}

const SERVICES: ServiceName[] = ['raiderio', 'warcraftlogs', 'wowaudit'];
const WINDOW_MINUTES = 60;

function emptyBucketCounts(): Record<Outcome, number> {
  return {
    ok: 0,
    retried: 0,
    rate_limited: 0,
    timeout: 0,
    failed: 0,
    circuit_rejected: 0,
  };
}

function freshState(): ServiceState {
  return {
    buckets: [],
    breaker: { state: 'closed', consecutiveFailures: 0 },
  };
}

const state = new Map<ServiceName, ServiceState>();
for (const s of SERVICES) state.set(s, freshState());

function currentMinute(): number {
  return Math.floor(Date.now() / 60_000);
}

function getOrCreateBucket(svc: ServiceState): MinuteBucket {
  const minute = currentMinute();
  let bucket = svc.buckets[svc.buckets.length - 1];
  if (!bucket || bucket.minuteEpoch !== minute) {
    bucket = { minuteEpoch: minute, counts: emptyBucketCounts() };
    svc.buckets.push(bucket);
  }
  // Evict buckets older than WINDOW_MINUTES
  const cutoff = minute - WINDOW_MINUTES + 1;
  while (svc.buckets.length > 0 && svc.buckets[0].minuteEpoch < cutoff) {
    svc.buckets.shift();
  }
  return bucket;
}

function evict(svc: ServiceState): void {
  const cutoff = currentMinute() - WINDOW_MINUTES + 1;
  while (svc.buckets.length > 0 && svc.buckets[0].minuteEpoch < cutoff) {
    svc.buckets.shift();
  }
}

export function recordOutcome(
  service: ServiceName,
  outcome: Outcome,
  errorDetail?: ErrorDetail,
): void {
  const svc = state.get(service);
  if (!svc) return;
  const bucket = getOrCreateBucket(svc);
  bucket.counts[outcome] += 1;
  if (errorDetail) {
    svc.lastError = { ...errorDetail, at: new Date() };
  }
}

export function getSummary(service: ServiceName): ServiceSummary {
  const svc = state.get(service);
  if (!svc) {
    return {
      totals: { ok: 0, retried: 0, rateLimited: 0, timeouts: 0, failed: 0, circuitRejected: 0 },
      breaker: 'closed',
    };
  }
  evict(svc);

  const totals = {
    ok: 0,
    retried: 0,
    rateLimited: 0,
    timeouts: 0,
    failed: 0,
    circuitRejected: 0,
  };
  for (const b of svc.buckets) {
    totals.ok += b.counts.ok;
    totals.retried += b.counts.retried;
    totals.rateLimited += b.counts.rate_limited;
    totals.timeouts += b.counts.timeout;
    totals.failed += b.counts.failed;
    totals.circuitRejected += b.counts.circuit_rejected;
  }

  return {
    totals,
    lastError: svc.lastError,
    breaker: svc.breaker.state,
  };
}

export function getAllSummaries(): Record<ServiceName, ServiceSummary> {
  return {
    raiderio: getSummary('raiderio'),
    warcraftlogs: getSummary('warcraftlogs'),
    wowaudit: getSummary('wowaudit'),
  };
}

// Test-only: reset all in-memory state.
export function __resetForTests(): void {
  state.clear();
  for (const s of SERVICES) state.set(s, freshState());
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/unit/apiHealth.test.ts`
Expected: PASS — 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/apiHealth.ts tests/unit/apiHealth.test.ts
git commit -m "feat(api-health): in-memory rolling tracker with 60-min sliding window"
```

---

## Task 2: apiHealth — circuit breaker state machine

**Files:**
- Modify: `src/services/apiHealth.ts`
- Test: `tests/unit/apiHealth.test.ts`

- [ ] **Step 1: Add failing breaker tests**

Append to `tests/unit/apiHealth.test.ts`:

```ts
import {
  isBreakerOpen,
  noteFailure,
  noteSuccess,
  onBreakerTrialResult,
} from '../../src/services/apiHealth.js';

describe('apiHealth breaker', () => {
  it('opens after 5 consecutive failures', () => {
    for (let i = 0; i < 4; i++) noteFailure('raiderio');
    expect(isBreakerOpen('raiderio')).toBe(false);
    expect(getSummary('raiderio').breaker).toBe('closed');

    noteFailure('raiderio');
    expect(isBreakerOpen('raiderio')).toBe(true);
    expect(getSummary('raiderio').breaker).toBe('open');
  });

  it('resets consecutive failures on success', () => {
    for (let i = 0; i < 4; i++) noteFailure('raiderio');
    noteSuccess('raiderio');
    for (let i = 0; i < 4; i++) noteFailure('raiderio');
    expect(isBreakerOpen('raiderio')).toBe(false);

    noteFailure('raiderio');
    expect(isBreakerOpen('raiderio')).toBe(true);
  });

  it('transitions open -> half_open after 60s cooldown', () => {
    for (let i = 0; i < 5; i++) noteFailure('raiderio');
    expect(getSummary('raiderio').breaker).toBe('open');

    vi.setSystemTime(new Date('2026-04-19T12:00:59Z'));
    expect(isBreakerOpen('raiderio')).toBe(true);

    vi.setSystemTime(new Date('2026-04-19T12:01:00Z'));
    expect(isBreakerOpen('raiderio')).toBe(false);
    expect(getSummary('raiderio').breaker).toBe('half_open');
  });

  it('half_open -> closed on trial success, resets counter', () => {
    for (let i = 0; i < 5; i++) noteFailure('raiderio');
    vi.setSystemTime(new Date('2026-04-19T12:01:00Z'));
    expect(getSummary('raiderio').breaker).toBe('half_open');

    onBreakerTrialResult('raiderio', true);
    expect(getSummary('raiderio').breaker).toBe('closed');

    for (let i = 0; i < 4; i++) noteFailure('raiderio');
    expect(isBreakerOpen('raiderio')).toBe(false);
  });

  it('half_open -> open on trial failure, cooldown resets', () => {
    for (let i = 0; i < 5; i++) noteFailure('raiderio');
    vi.setSystemTime(new Date('2026-04-19T12:01:00Z'));
    expect(getSummary('raiderio').breaker).toBe('half_open');

    onBreakerTrialResult('raiderio', false);
    expect(getSummary('raiderio').breaker).toBe('open');

    vi.setSystemTime(new Date('2026-04-19T12:01:59Z'));
    expect(isBreakerOpen('raiderio')).toBe(true);
    vi.setSystemTime(new Date('2026-04-19T12:02:00Z'));
    expect(isBreakerOpen('raiderio')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/apiHealth.test.ts`
Expected: FAIL — `isBreakerOpen`, `noteFailure`, `noteSuccess`, `onBreakerTrialResult` not exported.

- [ ] **Step 3: Implement breaker in `apiHealth.ts`**

Add near the top of `src/services/apiHealth.ts` after the `WINDOW_MINUTES` constant:

```ts
const BREAKER_OPEN_THRESHOLD = 5;
const BREAKER_COOLDOWN_MS = 60_000;
```

Append these exported functions to `src/services/apiHealth.ts` (after `__resetForTests`):

```ts
export function noteFailure(service: ServiceName): void {
  const svc = state.get(service);
  if (!svc) return;
  svc.breaker.consecutiveFailures += 1;
  if (
    svc.breaker.state === 'closed' &&
    svc.breaker.consecutiveFailures >= BREAKER_OPEN_THRESHOLD
  ) {
    svc.breaker.state = 'open';
    svc.breaker.openedAt = new Date();
  }
}

export function noteSuccess(service: ServiceName): void {
  const svc = state.get(service);
  if (!svc) return;
  svc.breaker.consecutiveFailures = 0;
}

export function isBreakerOpen(service: ServiceName): boolean {
  const svc = state.get(service);
  if (!svc) return false;

  if (svc.breaker.state === 'open' && svc.breaker.openedAt) {
    const elapsed = Date.now() - svc.breaker.openedAt.getTime();
    if (elapsed >= BREAKER_COOLDOWN_MS) {
      svc.breaker.state = 'half_open';
      return false;
    }
    return true;
  }

  // half_open and closed both permit a request attempt.
  return false;
}

export function onBreakerTrialResult(service: ServiceName, success: boolean): void {
  const svc = state.get(service);
  if (!svc) return;
  if (svc.breaker.state !== 'half_open') return;

  if (success) {
    svc.breaker.state = 'closed';
    svc.breaker.openedAt = undefined;
    svc.breaker.consecutiveFailures = 0;
  } else {
    svc.breaker.state = 'open';
    svc.breaker.openedAt = new Date();
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/unit/apiHealth.test.ts`
Expected: PASS — 10 tests pass (5 core + 5 breaker).

- [ ] **Step 5: Commit**

```bash
git add src/services/apiHealth.ts tests/unit/apiHealth.test.ts
git commit -m "feat(api-health): per-service circuit breaker state machine"
```

---

## Task 3: httpClient — skeleton + happy path + typed errors

**Files:**
- Create: `src/services/httpClient.ts`
- Test: `tests/unit/httpClient.test.ts`

- [ ] **Step 1: Write failing tests for the happy path and non-retryable errors**

Create `tests/unit/httpClient.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { __resetForTests } from '../../src/services/apiHealth.js';
import {
  httpRequest,
  HttpError,
} from '../../src/services/httpClient.js';
import { getSummary } from '../../src/services/apiHealth.js';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  __resetForTests();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-19T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockResponse(init: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  json?: unknown;
  headers?: Record<string, string>;
}): Response {
  const headers = new Headers(init.headers);
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    headers,
    json: async () => init.json ?? {},
  } as unknown as Response;
}

describe('httpRequest — happy path', () => {
  it('returns parsed JSON on 200', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse({ ok: true, json: { hello: 'world' } }),
    );

    const result = await httpRequest<{ hello: string }>('raiderio', 'https://x.test/');
    expect(result).toEqual({ hello: 'world' });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('records an ok outcome on success', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse({ ok: true, json: {} }));
    await httpRequest('raiderio', 'https://x.test/');
    expect(getSummary('raiderio').totals.ok).toBe(1);
  });
});

describe('httpRequest — non-retryable failures', () => {
  it.each([400, 401, 403, 404, 410, 422])(
    'throws HttpError immediately on %s without retry',
    async (status) => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({ ok: false, status, statusText: 'Bad' }),
      );
      globalThis.fetch = fetchMock;

      await expect(httpRequest('raiderio', 'https://x.test/')).rejects.toBeInstanceOf(
        HttpError,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it('HttpError carries service, status, attempts', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse({ ok: false, status: 404, statusText: 'Not Found' }),
    );

    try {
      await httpRequest('raiderio', 'https://x.test/');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      const e = err as HttpError;
      expect(e.service).toBe('raiderio');
      expect(e.status).toBe(404);
      expect(e.attempts).toBe(1);
    }
  });

  it('records failed outcome on non-retryable error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse({ ok: false, status: 404, statusText: 'Not Found' }),
    );

    await httpRequest('raiderio', 'https://x.test/').catch(() => {});
    const s = getSummary('raiderio');
    expect(s.totals.failed).toBe(1);
    expect(s.lastError?.status).toBe(404);
  });

  it('throws on JSON parse error without retry', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
    } as unknown as Response);

    await expect(httpRequest('raiderio', 'https://x.test/')).rejects.toBeInstanceOf(
      HttpError,
    );
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/httpClient.test.ts`
Expected: FAIL — module `../../src/services/httpClient.js` not found.

- [ ] **Step 3: Implement httpClient skeleton**

Create `src/services/httpClient.ts`:

```ts
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
  const parseJson = opts?.parseJson ?? true;
  const attempts = 1;

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    recordOutcome(service, 'failed', { msg: e.message });
    noteFailure(service);
    throw new HttpError({
      service, attempts, message: `${service} request failed: ${e.message}`, lastError: e,
    });
  }

  if (!response.ok) {
    recordOutcome(service, 'failed', {
      msg: `${response.status} ${response.statusText}`,
      status: response.status,
    });
    noteFailure(service);
    throw new HttpError({
      service, attempts, status: response.status,
      message: `${service} API error: ${response.status} ${response.statusText}`,
    });
  }

  if (!parseJson) {
    recordOutcome(service, 'ok');
    noteSuccess(service);
    return undefined as T;
  }

  try {
    const data = (await response.json()) as T;
    recordOutcome(service, 'ok');
    noteSuccess(service);
    return data;
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    recordOutcome(service, 'failed', { msg: `JSON parse error: ${e.message}` });
    noteFailure(service);
    throw new HttpError({
      service, attempts,
      message: `${service} JSON parse error: ${e.message}`, lastError: e,
    });
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/unit/httpClient.test.ts`
Expected: PASS — all happy-path and non-retryable tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/httpClient.ts tests/unit/httpClient.test.ts
git commit -m "feat(http-client): skeleton with happy path + typed errors"
```

---

## Task 4: httpClient — timeout via AbortSignal.timeout

**Files:**
- Modify: `src/services/httpClient.ts`
- Modify: `tests/unit/httpClient.test.ts`

- [ ] **Step 1: Add failing timeout test**

Append to `tests/unit/httpClient.test.ts`:

```ts
describe('httpRequest — timeout', () => {
  it('aborts the request after timeoutMs and throws HttpError', async () => {
    globalThis.fetch = vi.fn().mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            signal.addEventListener('abort', () => {
              const err = new Error('aborted');
              (err as Error & { name: string }).name = 'AbortError';
              reject(err);
            });
          }
        }),
    );

    const promise = httpRequest('raiderio', 'https://x.test/', undefined, {
      timeoutMs: 100,
      maxRetries: 0,
    });

    await vi.advanceTimersByTimeAsync(101);
    await expect(promise).rejects.toBeInstanceOf(HttpError);
  });

  it('passes caller-provided signal alongside timeout', async () => {
    const abortController = new AbortController();
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ ok: true, json: {} }));
    globalThis.fetch = fetchMock;

    await httpRequest('raiderio', 'https://x.test/', { signal: abortController.signal });

    const init = fetchMock.mock.calls[0][1] as RequestInit | undefined;
    expect(init?.signal).toBeDefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/httpClient.test.ts`
Expected: FAIL — timeout test hangs or fails; `timeoutMs` option is not honoured.

- [ ] **Step 3: Add timeout handling to `httpRequest`**

Replace the single-attempt body of `httpRequest` in `src/services/httpClient.ts` (everything after the opening brace) with:

```ts
  const timeoutMs = opts?.timeoutMs ?? 10_000;
  const parseJson = opts?.parseJson ?? true;
  const attempts = 1;

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init?.signal
    ? mergeSignals([init.signal, timeoutSignal])
    : timeoutSignal;

  let response: Response;
  try {
    response = await fetch(url, { ...init, signal });
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    const isTimeout = e.name === 'AbortError' || e.name === 'TimeoutError';
    const outcome = isTimeout ? 'timeout' : 'failed';
    recordOutcome(service, outcome, { msg: e.message });
    noteFailure(service);
    throw new HttpError({
      service, attempts,
      message: isTimeout
        ? `${service} request timed out after ${timeoutMs}ms`
        : `${service} request failed: ${e.message}`,
      lastError: e,
    });
  }

  if (!response.ok) {
    recordOutcome(service, 'failed', {
      msg: `${response.status} ${response.statusText}`,
      status: response.status,
    });
    noteFailure(service);
    throw new HttpError({
      service, attempts, status: response.status,
      message: `${service} API error: ${response.status} ${response.statusText}`,
    });
  }

  if (!parseJson) {
    recordOutcome(service, 'ok');
    noteSuccess(service);
    return undefined as T;
  }

  try {
    const data = (await response.json()) as T;
    recordOutcome(service, 'ok');
    noteSuccess(service);
    return data;
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    recordOutcome(service, 'failed', { msg: `JSON parse error: ${e.message}` });
    noteFailure(service);
    throw new HttpError({
      service, attempts,
      message: `${service} JSON parse error: ${e.message}`, lastError: e,
    });
  }
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
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/unit/httpClient.test.ts`
Expected: PASS — all existing tests plus the two new timeout tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/httpClient.ts tests/unit/httpClient.test.ts
git commit -m "feat(http-client): per-request timeout via AbortSignal.timeout"
```

---

## Task 5: httpClient — retry loop with backoff + jitter

**Files:**
- Modify: `src/services/httpClient.ts`
- Modify: `tests/unit/httpClient.test.ts`

- [ ] **Step 1: Add failing retry tests**

Append to `tests/unit/httpClient.test.ts`:

```ts
describe('httpRequest — retry loop', () => {
  it.each([429, 500, 502, 503, 504])(
    'retries on %s up to maxRetries+1 attempts',
    async (status) => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({ ok: false, status, statusText: 'x' }),
      );
      globalThis.fetch = fetchMock;

      const promise = httpRequest('raiderio', 'https://x.test/').catch((e) => e);
      await vi.advanceTimersByTimeAsync(5_000);
      const err = await promise;

      expect(err).toBeInstanceOf(HttpError);
      expect(fetchMock).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
    },
  );

  it('succeeds on retry and records `retried`', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ ok: false, status: 503, statusText: 'x' }))
      .mockResolvedValueOnce(mockResponse({ ok: true, json: { ok: 1 } }));

    const promise = httpRequest<{ ok: number }>('raiderio', 'https://x.test/');
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await promise;

    expect(result).toEqual({ ok: 1 });
    const s = getSummary('raiderio');
    expect(s.totals.ok).toBe(1);
    expect(s.totals.retried).toBe(1);
  });

  it('records `rate_limited` when any attempt saw a 429 and the call ultimately fails', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse({ ok: false, status: 429, statusText: 'Too Many Requests' }),
    );

    const promise = httpRequest('raiderio', 'https://x.test/').catch((e) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    await promise;

    const s = getSummary('raiderio');
    expect(s.totals.rateLimited).toBe(1);
    expect(s.totals.failed).toBe(0);
  });

  it('records `timeout` when any attempt timed out and the call ultimately fails', async () => {
    globalThis.fetch = vi.fn().mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            (err as Error & { name: string }).name = 'AbortError';
            reject(err);
          });
        }),
    );

    const promise = httpRequest('raiderio', 'https://x.test/', undefined, {
      timeoutMs: 50,
    }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    await promise;

    const s = getSummary('raiderio');
    expect(s.totals.timeouts).toBe(1);
  });

  it('does not retry on 404', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse({ ok: false, status: 404, statusText: 'Not Found' }),
    );
    globalThis.fetch = fetchMock;

    await httpRequest('raiderio', 'https://x.test/').catch(() => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries on network throw (TypeError)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    globalThis.fetch = fetchMock;

    const promise = httpRequest('raiderio', 'https://x.test/').catch(() => {});
    await vi.advanceTimersByTimeAsync(5_000);
    await promise;

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/httpClient.test.ts`
Expected: FAIL — retry tests see exactly 1 fetch call, not 3.

- [ ] **Step 3: Implement the retry loop**

Replace the entire exported `httpRequest` body in `src/services/httpClient.ts` with this loop-based version (keep the existing `HttpError`, `CircuitOpenError`, `RETRYABLE_STATUSES`, `mergeSignals`, and comment block intact above it):

```ts
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
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal
      ? mergeSignals([init.signal, timeoutSignal])
      : timeoutSignal;

    let response: Response;
    try {
      response = await fetch(url, { ...init, signal });
    } catch (err) {
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
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/unit/httpClient.test.ts`
Expected: PASS — all prior tests + all retry tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/httpClient.ts tests/unit/httpClient.test.ts
git commit -m "feat(http-client): retry loop with exponential backoff + jitter"
```

---

## Task 6: httpClient — Retry-After header

**Files:**
- Modify: `src/services/httpClient.ts`
- Modify: `tests/unit/httpClient.test.ts`

- [ ] **Step 1: Add failing Retry-After tests**

Append to `tests/unit/httpClient.test.ts`:

```ts
describe('httpRequest — Retry-After', () => {
  it('honours Retry-After in seconds', async () => {
    const sleepStart = Date.now();
    let observedGap = 0;

    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        mockResponse({
          ok: false, status: 429, statusText: 'x',
          headers: { 'Retry-After': '5' },
        }),
      )
      .mockImplementationOnce(async () => {
        observedGap = Date.now() - sleepStart;
        return mockResponse({ ok: true, json: {} });
      });

    const promise = httpRequest('raiderio', 'https://x.test/');
    await vi.advanceTimersByTimeAsync(6_000);
    await promise;

    expect(observedGap).toBeGreaterThanOrEqual(5_000);
  });

  it('honours Retry-After as HTTP-date', async () => {
    const sleepStart = Date.now();
    const futureDate = new Date(sleepStart + 2_000).toUTCString();
    let observedGap = 0;

    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        mockResponse({
          ok: false, status: 503, statusText: 'x',
          headers: { 'Retry-After': futureDate },
        }),
      )
      .mockImplementationOnce(async () => {
        observedGap = Date.now() - sleepStart;
        return mockResponse({ ok: true, json: {} });
      });

    const promise = httpRequest('raiderio', 'https://x.test/');
    await vi.advanceTimersByTimeAsync(3_000);
    await promise;

    expect(observedGap).toBeGreaterThanOrEqual(2_000);
  });

  it('treats Retry-After > 30s as final failure without waiting', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse({
        ok: false, status: 429, statusText: 'x',
        headers: { 'Retry-After': '120' },
      }),
    );
    globalThis.fetch = fetchMock;

    const err = await httpRequest('raiderio', 'https://x.test/').catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const s = getSummary('raiderio');
    expect(s.totals.rateLimited).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/httpClient.test.ts`
Expected: FAIL — current backoff ignores `Retry-After`.

- [ ] **Step 3: Integrate Retry-After into the retry loop**

In `src/services/httpClient.ts`, add this constant near `RETRYABLE_STATUSES`:

```ts
const RETRY_AFTER_CAP_MS = 30_000;
```

Add this helper above `computeBackoffMs`:

```ts
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.floor(seconds * 1_000);
  }
  const asDate = Date.parse(trimmed);
  if (!Number.isNaN(asDate)) {
    return Math.max(0, asDate - Date.now());
  }
  return null;
}
```

In the main loop, replace the non-ok branch (the `lastStatus = response.status;` block through the `await sleep(computeBackoffMs(attempt));` at the end of the iteration) with:

```ts
    lastStatus = response.status;
    if (response.status === 429) sawRateLimit = true;

    if (!RETRYABLE_STATUSES.has(response.status)) {
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

    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
    if (retryAfterMs !== null && retryAfterMs > RETRY_AFTER_CAP_MS) {
      // Upstream told us to wait longer than our cap; treat as final failure.
      const outcome = sawRateLimit ? 'rate_limited' : 'failed';
      recordOutcome(service, outcome, {
        msg: `Retry-After ${Math.round(retryAfterMs / 1_000)}s exceeds ${RETRY_AFTER_CAP_MS / 1_000}s cap`,
        status: response.status,
      });
      noteFailure(service);
      throw new HttpError({
        service, attempts: attempt, status: response.status,
        message: `${service} Retry-After exceeds ${RETRY_AFTER_CAP_MS / 1_000}s cap`,
      });
    }

    if (attempt > maxRetries) break;
    const waitMs = retryAfterMs !== null ? retryAfterMs : computeBackoffMs(attempt);
    await sleep(waitMs);
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/unit/httpClient.test.ts`
Expected: PASS — all prior tests + three Retry-After tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/httpClient.ts tests/unit/httpClient.test.ts
git commit -m "feat(http-client): honour Retry-After header with 30s cap"
```

---

## Task 7: httpClient — circuit breaker integration

**Files:**
- Modify: `src/services/httpClient.ts`
- Modify: `tests/unit/httpClient.test.ts`

- [ ] **Step 1: Add failing breaker-integration tests**

Append to `tests/unit/httpClient.test.ts`:

```ts
import {
  isBreakerOpen,
} from '../../src/services/apiHealth.js';
import { CircuitOpenError } from '../../src/services/httpClient.js';

describe('httpRequest — circuit breaker integration', () => {
  it('opens the breaker after 5 consecutive failed calls', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse({ ok: false, status: 404, statusText: 'x' }),
    );

    for (let i = 0; i < 5; i++) {
      await httpRequest('raiderio', 'https://x.test/').catch(() => {});
    }
    expect(isBreakerOpen('raiderio')).toBe(true);
  });

  it('fast-fails with CircuitOpenError while open, without calling fetch', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse({ ok: false, status: 404, statusText: 'x' }),
    );
    for (let i = 0; i < 5; i++) {
      await httpRequest('raiderio', 'https://x.test/').catch(() => {});
    }

    const callCountBefore = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    await expect(
      httpRequest('raiderio', 'https://x.test/'),
    ).rejects.toBeInstanceOf(CircuitOpenError);

    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callCountBefore);
    expect(getSummary('raiderio').totals.circuitRejected).toBe(1);
  });

  it('half_open -> closed on a successful trial call', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse({ ok: false, status: 500, statusText: 'x' }),
    );
    const kick = async () => {
      const p = httpRequest('raiderio', 'https://x.test/').catch(() => {});
      await vi.advanceTimersByTimeAsync(5_000);
      return p;
    };
    for (let i = 0; i < 5; i++) await kick();
    expect(getSummary('raiderio').breaker).toBe('open');

    // Fast-forward past 60s cooldown.
    vi.setSystemTime(new Date(Date.now() + 61_000));
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse({ ok: true, json: {} }));

    await httpRequest('raiderio', 'https://x.test/');
    expect(getSummary('raiderio').breaker).toBe('closed');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/httpClient.test.ts`
Expected: FAIL — breaker state is not gating fetches; trial success is not closing the breaker.

- [ ] **Step 3: Add the breaker check and half-open trial handling**

In `src/services/httpClient.ts`:

Add to the imports near the top:

```ts
import {
  recordOutcome, noteFailure, noteSuccess,
  isBreakerOpen, onBreakerTrialResult,
} from './apiHealth.js';
import { getSummary } from './apiHealth.js';
```

At the *start* of `httpRequest` (before `const timeoutMs = ...`), add:

```ts
  if (isBreakerOpen(service)) {
    recordOutcome(service, 'circuit_rejected', {
      msg: `Circuit open for ${service}`,
    });
    throw new CircuitOpenError(service);
  }

  // If the breaker is in half_open, this call is the trial.
  const breakerWasHalfOpen = getSummary(service).breaker === 'half_open';
```

Modify `finishSuccess` to accept and propagate the half-open flag:

```ts
function finishSuccess(service: ServiceName, attempt: number, wasTrial: boolean): void {
  recordOutcome(service, 'ok');
  if (attempt > 1) recordOutcome(service, 'retried');
  noteSuccess(service);
  if (wasTrial) onBreakerTrialResult(service, true);
}
```

Update the two call sites of `finishSuccess` inside the loop to pass `breakerWasHalfOpen`:

```ts
      if (!parseJson) {
        finishSuccess(service, attempt, breakerWasHalfOpen);
        return undefined as T;
      }
      try {
        const data = (await response.json()) as T;
        finishSuccess(service, attempt, breakerWasHalfOpen);
        return data;
```

After the `throw new HttpError(...)` calls at the non-retryable and Retry-After-exceeded branches, and after the final "Exhausted retries" throw, add a single helper call on the failure path. The cleanest way: introduce a `onFinalFailure` helper that wraps the final `throw new HttpError`, and call `onBreakerTrialResult(service, false)` from it when `breakerWasHalfOpen`. Refactor as follows — replace each final-failure `throw new HttpError({...})` with an explicit `onBreakerTrialResult` call first:

Define this helper near `finishSuccess`:

```ts
function onFinalFailure(service: ServiceName, wasTrial: boolean): void {
  if (wasTrial) onBreakerTrialResult(service, false);
}
```

Before each final-failure `throw new HttpError(...)` in `httpRequest` (there are three: non-retryable HTTP error, Retry-After exceeded, and the exhausted-retries throw), insert `onFinalFailure(service, breakerWasHalfOpen);`. Also insert the same call before the JSON-parse-error `throw` (a parse error on a half-open trial counts as a trial failure).

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/unit/httpClient.test.ts`
Expected: PASS — all prior tests + three breaker-integration tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/httpClient.ts tests/unit/httpClient.test.ts
git commit -m "feat(http-client): integrate circuit breaker with half-open trial"
```

---

## Task 8: Refactor `raiderio.ts` to use `httpRequest`

**Files:**
- Modify: `src/services/raiderio.ts`
- Modify: `tests/unit/raiderio.test.ts`

- [ ] **Step 1: Update failing tests to expect new error shape + retries on 5xx**

Open `tests/unit/raiderio.test.ts` and replace the two `should throw on non-OK response` tests with these. The first now expects retries on 5xx; the second (404 on `getRaidRankings`) is non-retryable.

Replace `getGuildRoster`'s `should throw on non-OK response`:

```ts
  it('retries on 5xx and throws HttpError after exhausting retries', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false, status: 500, statusText: 'Internal Server Error',
      headers: new Headers(),
    });
    globalThis.fetch = fetchMock;

    const promise = getGuildRoster().catch((e) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    const err = await promise;

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('raiderio');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });
```

Replace `getRaidRankings`'s `should throw on non-OK response`:

```ts
  it('throws HttpError without retry on 404', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false, status: 404, statusText: 'Not Found',
      headers: new Headers(),
    });
    globalThis.fetch = fetchMock;

    await expect(getRaidRankings('invalid')).rejects.toThrow('raiderio');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
```

Every existing happy-path mock in this file needs a `headers: new Headers()` field added so `response.headers.get(...)` works inside `httpRequest`. Update each `vi.fn().mockResolvedValue({ ok: true, ... })` to include `headers: new Headers()`. Example:

```ts
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: async () => ({ members: mockMembers }),
    });
```

Also add `import { __resetForTests } from '../../src/services/apiHealth.js';` at the top and call it in `beforeEach`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/raiderio.test.ts`
Expected: FAIL — `raiderio.ts` still uses raw `fetch`; error messages and retry counts don't match.

- [ ] **Step 3: Refactor `raiderio.ts`**

Replace `src/services/raiderio.ts` with:

```ts
import { config } from '../config.js';
import { httpRequest } from './httpClient.js';

const BASE_URL = 'https://raider.io/api/v1';
const ROSTER_RANKS = [0, 1, 3, 4, 5, 7];

export interface RaiderIoMember {
  rank: number;
  character: {
    name: string;
    realm: string;
    region: string;
    class: string;
  };
}

export interface RaidRanking {
  rank: number;
  guild: {
    name: string;
    realm: string;
    region: string;
  };
  encountersDefeated: number;
  encountersTotal: number;
}

export interface RaidStaticData {
  raids: Array<{
    id: number;
    slug: string;
    name: string;
    expansion_id: number;
    starts: { us: string | null; eu: string | null };
    ends: { us: string | null; eu: string | null };
    encounters: Array<{
      id: number;
      slug: string;
      name: string;
    }>;
  }>;
}

export interface MythicPlusRun {
  dungeon: string;
  short_name: string;
  mythic_level: number;
  num_keystone_upgrades: number;
  score: number;
}

export async function getGuildRoster(): Promise<RaiderIoMember[]> {
  const url = `${BASE_URL}/guilds/profile?region=eu&realm=silvermoon&name=seriouslycasual&fields=members`;
  const data = await httpRequest<{ members: RaiderIoMember[] }>('raiderio', url);
  return data.members.filter((m) => ROSTER_RANKS.includes(m.rank));
}

export async function getRaidRankings(raidSlug: string): Promise<RaidRanking[]> {
  const url = `${BASE_URL}/raiding/raid-rankings?raid=${raidSlug}&difficulty=mythic&region=world&guilds=${config.raiderIoGuildIds}&limit=50`;
  const data = await httpRequest<{ raidRankings: RaidRanking[] }>('raiderio', url);
  return data.raidRankings;
}

export async function getRaidStaticData(expansionId: number): Promise<RaidStaticData> {
  const url = `${BASE_URL}/raiding/static-data?expansion_id=${expansionId}`;
  return httpRequest<RaidStaticData>('raiderio', url);
}

export async function getWeeklyMythicPlusRuns(
  region: string,
  realm: string,
  name: string,
): Promise<MythicPlusRun[]> {
  const url = `${BASE_URL}/characters/profile?region=${region}&realm=${realm}&name=${encodeURIComponent(name)}&fields=mythic_plus_previous_weekly_highest_level_runs`;
  const data = await httpRequest<{
    mythic_plus_previous_weekly_highest_level_runs: MythicPlusRun[];
  }>('raiderio', url);
  return data.mythic_plus_previous_weekly_highest_level_runs;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/unit/raiderio.test.ts`
Expected: PASS — updated tests pass; URL-shape assertions continue to pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/raiderio.ts tests/unit/raiderio.test.ts
git commit -m "refactor(raiderio): route through shared httpClient"
```

---

## Task 9: Refactor `wowaudit.ts` to use `httpRequest`

**Files:**
- Modify: `src/services/wowaudit.ts`
- Modify: `tests/unit/wowaudit.test.ts`

- [ ] **Step 1: Update wowaudit tests the same way**

In `tests/unit/wowaudit.test.ts`:
- Add `import { __resetForTests } from '../../src/services/apiHealth.js';` and call it in `beforeEach` (add a `beforeEach` if none exists).
- Add `headers: new Headers()` to every `mockResolvedValue({ ok: true, ... })`.
- Replace the three `should throw on non-OK response` tests to expect `HttpError` and (for 5xx cases) retries.

Replace `getUpcomingRaids`'s `should throw on non-OK response`:

```ts
  it('throws HttpError without retry on 401', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false, status: 401, statusText: 'Unauthorized', headers: new Headers(),
    });
    globalThis.fetch = fetchMock;

    await expect(getUpcomingRaids()).rejects.toThrow('wowaudit');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
```

Replace the 500-on-getCurrentPeriod case in `getHistoricalData`:

```ts
  it('retries on 500 from getCurrentPeriod and throws HttpError', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false, status: 500, statusText: 'Internal Server Error',
      headers: new Headers(),
    });
    globalThis.fetch = fetchMock;

    const promise = getHistoricalData().catch((e) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    const err = await promise;

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('wowaudit');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });
```

Replace the 404-on-historical-data case:

```ts
  it('throws HttpError without retry when historical data returns 404', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true, headers: new Headers(),
        json: async () => ({ current_period: 42 }),
      })
      .mockResolvedValueOnce({
        ok: false, status: 404, statusText: 'Not Found', headers: new Headers(),
      });
    globalThis.fetch = fetchMock;

    await expect(getHistoricalData()).rejects.toThrow('wowaudit');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/wowaudit.test.ts`
Expected: FAIL — `wowaudit.ts` still uses raw `fetch`.

- [ ] **Step 3: Refactor `wowaudit.ts`**

Replace `src/services/wowaudit.ts` with:

```ts
import { config } from '../config.js';
import { httpRequest } from './httpClient.js';

const BASE_URL = 'https://wowaudit.com/v1';

function headers(): Record<string, string> {
  return {
    accept: 'application/json',
    Authorization: config.wowAuditApiSecret,
  };
}

export interface WowAuditRaid {
  id: number;
  date: string;
  title: string;
  note: string;
  signups: Array<{
    character: {
      name: string;
      realm: string;
      class_name: string;
    };
    status: string;
  }>;
}

export interface WowAuditHistoricalEntry {
  character: {
    name: string;
    realm: string;
  };
  data: Record<string, unknown>;
}

async function getCurrentPeriod(): Promise<number> {
  const data = await httpRequest<{ current_period: number }>(
    'wowaudit',
    `${BASE_URL}/period`,
    { headers: headers() },
  );
  return data.current_period;
}

export async function getUpcomingRaids(): Promise<WowAuditRaid[]> {
  return httpRequest<WowAuditRaid[]>(
    'wowaudit',
    `${BASE_URL}/raids?include_past=false`,
    { headers: headers() },
  );
}

export async function getHistoricalData(): Promise<WowAuditHistoricalEntry[]> {
  const currentPeriod = await getCurrentPeriod();
  const previousPeriod = currentPeriod - 1;

  return httpRequest<WowAuditHistoricalEntry[]>(
    'wowaudit',
    `${BASE_URL}/historical_data?period=${previousPeriod}`,
    { headers: headers() },
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/unit/wowaudit.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/wowaudit.ts tests/unit/wowaudit.test.ts
git commit -m "refactor(wowaudit): route through shared httpClient"
```

---

## Task 10: Refactor `warcraftlogs.ts` (preserve `getTrialLogs` fail-soft)

**Files:**
- Modify: `src/services/warcraftlogs.ts`

- [ ] **Step 1: Refactor `warcraftlogs.ts`**

Replace `src/services/warcraftlogs.ts` with:

```ts
import { config } from '../config.js';
import { logger } from './logger.js';
import { httpRequest, HttpError, CircuitOpenError } from './httpClient.js';

// ─── Token Cache ─────────────────────────────────────────────

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

interface TokenResponse {
  access_token: string;
  expires_in: number;
}

async function getAccessToken(): Promise<string> {
  const now = Date.now();

  if (cachedToken && now < tokenExpiresAt) {
    return cachedToken;
  }

  const body = new URLSearchParams({ grant_type: 'client_credentials' });

  const data = await httpRequest<TokenResponse>(
    'warcraftlogs',
    'https://www.warcraftlogs.com/oauth/token',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization:
          'Basic ' +
          Buffer.from(
            `${config.warcraftLogsClientId}:${config.warcraftLogsClientSecret}`,
          ).toString('base64'),
      },
      body: body.toString(),
    },
  );

  cachedToken = data.access_token;
  // Expire 60 seconds early to avoid edge cases
  tokenExpiresAt = now + (data.expires_in - 60) * 1000;

  logger.debug('WarcraftLogs', 'Refreshed OAuth2 access token');

  return cachedToken;
}

// ─── GraphQL Query ───────────────────────────────────────────

interface AttendancePlayer {
  name: string;
  presence: number;
  type: string;
}

interface AttendanceReport {
  code: string;
  players: AttendancePlayer[];
}

interface GuildAttendanceResponse {
  data: {
    guildData: {
      guild: {
        id: number;
        name: string;
        attendance: {
          data: AttendanceReport[];
        };
      };
    };
  };
}

const ATTENDANCE_QUERY = `
  query getGuildAttendance($guildId: Int) {
    guildData {
      guild(id: $guildId) {
        id
        name
        attendance {
          data {
            code
            players { name, presence, type }
          }
        }
      }
    }
  }
`;

/**
 * Fetch WarcraftLogs report codes where `characterName` was present.
 * Returns codes in reverse chronological order (newest first).
 * Returns empty array on any HTTP error or open circuit (fail-soft).
 */
export async function getTrialLogs(characterName: string): Promise<string[]> {
  try {
    const token = await getAccessToken();

    const result = await httpRequest<GuildAttendanceResponse>(
      'warcraftlogs',
      'https://www.warcraftlogs.com/api/v2/client',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: ATTENDANCE_QUERY,
          variables: {
            guildId: parseInt(config.warcraftLogsGuildId, 10),
          },
        }),
      },
    );

    const reports = result.data.guildData.guild.attendance.data;

    const matchingCodes = reports
      .filter((report) =>
        report.players.some(
          (player) =>
            player.name === characterName && player.presence === 1,
        ),
      )
      .map((report) => report.code);

    return matchingCodes.reverse();
  } catch (error) {
    if (error instanceof HttpError || error instanceof CircuitOpenError) {
      logger.warn(
        'WarcraftLogs',
        `Failed to fetch trial logs for "${characterName}": ${error.message}`,
      );
      return [];
    }
    throw error;
  }
}
```

- [ ] **Step 2: Run existing tests to verify nothing regresses**

Run: `npx vitest run`
Expected: PASS — the full suite still passes. No WarcraftLogs unit tests exist currently; integration and other unit tests should be unaffected.

- [ ] **Step 3: Commit**

```bash
git add src/services/warcraftlogs.ts
git commit -m "refactor(warcraftlogs): route through shared httpClient; preserve fail-soft"
```

---

## Task 11: `/status` — render API health section

**Files:**
- Modify: `src/commands/status.ts`

- [ ] **Step 1: Extend `status.ts`**

Edit `src/commands/status.ts`. Add the import near the existing ones:

```ts
import { getAllSummaries, type BreakerState, type ServiceSummary } from '../services/apiHealth.js';
```

Add this helper near the bottom of the file, above the `export default`:

```ts
function breakerEmoji(state: BreakerState): string {
  if (state === 'open') return '🔴';
  if (state === 'half_open') return '🟡';
  return '🟢';
}

function formatApiHealthLine(label: string, summary: ServiceSummary): string {
  const { totals, breaker, lastError } = summary;
  const totalCalls =
    totals.ok + totals.rateLimited + totals.timeouts + totals.failed + totals.circuitRejected;

  if (totalCalls === 0) {
    return `**${label}**  ${breakerEmoji(breaker)} ${breaker}  ·  — no traffic`;
  }

  const successPart = totals.retried > 0
    ? `${totals.ok} ok (${totals.retried} retried)`
    : `${totals.ok} ok`;

  const failureParts: string[] = [];
  const totalFailures = totals.rateLimited + totals.timeouts + totals.failed + totals.circuitRejected;
  if (totalFailures > 0) {
    const breakdown: string[] = [];
    if (totals.rateLimited > 0) breakdown.push(`${totals.rateLimited} rate-limited`);
    if (totals.timeouts > 0) breakdown.push(`${totals.timeouts} timeouts`);
    if (totals.circuitRejected > 0) breakdown.push(`${totals.circuitRejected} circuit-rejected`);
    const breakdownStr = breakdown.length > 0 ? ` (${breakdown.join(', ')})` : '';
    failureParts.push(`${totalFailures} failed${breakdownStr}`);
  } else {
    failureParts.push('0 failed');
  }

  let line = `**${label}**  ${breakerEmoji(breaker)} ${breaker}  ·  ${successPart}  ·  ${failureParts.join(', ')}`;
  if (lastError) {
    const hh = String(lastError.at.getUTCHours()).padStart(2, '0');
    const mm = String(lastError.at.getUTCMinutes()).padStart(2, '0');
    const statusPart = lastError.status ? `${lastError.status} ` : '';
    line += `\nlast error: ${statusPart}${hh}:${mm} UTC — ${lastError.msg}`;
  }
  return line;
}
```

Then, inside `execute`, append the API health fields after the existing fields. Replace the existing `.addFields(...)` block with:

```ts
    const apiSummaries = getAllSummaries();

    const embed = createEmbed('Bot Status')
      .addFields(
        { name: 'Uptime', value: `${hours}h ${minutes}m ${seconds}s`, inline: true },
        { name: 'Log Level', value: logger.getLevel(), inline: true },
        { name: 'DB Size', value: dbSizeStr, inline: true },
        { name: 'Raiders', value: `${raiders.linked}/${raiders.total} linked`, inline: true },
        { name: 'Active Applications', value: `${activeApps.count}`, inline: true },
        { name: 'Active Trials', value: `${activeTrials.count}`, inline: true },
        { name: 'Last Roster Sync', value: formatAge(syncStatus?.lastRun), inline: true },
        { name: 'Last Achievements Update', value: formatAge(achievementsStatus?.lastRun), inline: true },
        { name: 'Last Trial Logs Update', value: formatAge(trialLogsStatus?.lastRun), inline: true },
        { name: 'EPGP Last Upload', value: epgpLastUpload, inline: true },
        { name: '\u200B', value: '**API Health (last hour)**', inline: false },
        { name: '\u200B', value: formatApiHealthLine('Raider.io', apiSummaries.raiderio), inline: false },
        { name: '\u200B', value: formatApiHealthLine('WarcraftLogs', apiSummaries.warcraftlogs), inline: false },
        { name: '\u200B', value: formatApiHealthLine('wowaudit', apiSummaries.wowaudit), inline: false },
      );
```

- [ ] **Step 2: Build the project to catch type errors**

Run: `npx tsc --noEmit`
Expected: clean — no type errors.

- [ ] **Step 3: Commit**

```bash
git add src/commands/status.ts
git commit -m "feat(status): render API health section (last hour) per service"
```

---

## Task 12: `interactionCreate` — friendlier message for `CircuitOpenError`

**Files:**
- Modify: `src/events/interactionCreate.ts`

- [ ] **Step 1: Add the CircuitOpenError branch to the ChatInput error handler**

Edit `src/events/interactionCreate.ts`. Add the import at the top with the others:

```ts
import { CircuitOpenError } from '../services/httpClient.js';
```

Replace the existing ChatInput `catch` block (around lines 56–66, the one that starts with `} catch (error) {` after `await command.execute(interaction);`) with:

```ts
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error('interaction', `Command ${interaction.commandName} failed: ${err.message}`, err);

        const message =
          err instanceof CircuitOpenError
            ? `⚠️ ${err.service} is currently unreachable (circuit open). Try again in ~60s.`
            : 'There was an error executing this command.';
        const reply = { content: message, flags: MessageFlags.Ephemeral } as const;
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp(reply).catch(() => {});
        } else {
          await interaction.reply(reply).catch(() => {});
        }
      }
```

- [ ] **Step 2: Build to catch type errors**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Run the full suite one more time**

Run: `npx vitest run`
Expected: PASS — full suite green.

- [ ] **Step 4: Commit**

```bash
git add src/events/interactionCreate.ts
git commit -m "feat(interaction): friendlier ChatInput message on CircuitOpenError"
```

---

## Task 13: Integration smoke

**Files:** none

- [ ] **Step 1: Run the complete test suite**

Run: `npx vitest run`
Expected: PASS — all unit + integration tests green.

- [ ] **Step 2: Type-check the entire project**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Manual verification checklist (documented for the reviewer)**

Start the bot locally:

```bash
npm run dev
```

From the test guild, in order:
1. Run `/status` — confirm a new "API Health (last hour)" heading plus three per-service rows are present with `🟢 closed  ·  — no traffic`.
2. Run `/raiders sync_raiders` once — confirm `/status` now shows `1 ok` on the `Raider.io` line.
3. Temporarily point `raiderio.ts` `BASE_URL` to `https://raider.io/api/v1/invalid-endpoint` (a 404 path), restart the bot, run `sync_raiders`. Expect the call to fail fast (1 attempt, 404 non-retryable), `/status` should show `1 failed` with the 404 in `last error`.
4. Temporarily point `BASE_URL` to a URL that returns 500 (e.g., use `https://httpbin.org/status/500`). Run `sync_raiders` 5 times. Confirm the breaker shows `🔴 open` on `/status` and that a subsequent invocation replies with `⚠️ raiderio is currently unreachable (circuit open). Try again in ~60s.`.
5. Wait 60s, run `sync_raiders` again with the URL restored to a good endpoint. Confirm the breaker transitions back to `🟢 closed` on `/status`.

If all five pass, the implementation is correct.

---

## Self-Review (by plan author)

**Spec coverage check** — every section in the spec has an implementing task:

- Architecture (httpClient, apiHealth, service refactors, status extension, interactionCreate) → Tasks 1–12
- Retry policy (what retries, what doesn't, backoff, Retry-After, outcome classification) → Tasks 3, 5, 6
- Circuit breaker (state machine, open threshold, cooldown, half-open trial, behaviour while open) → Tasks 2, 7
- Error handling & fail-soft boundary (getTrialLogs swallow, scheduler propagation, interactionCreate CircuitOpenError branch) → Tasks 10, 12
- /status surface (API health section, rendering rules) → Task 11
- Testing (httpClient unit, apiHealth unit, existing service test audit) → Tasks 1, 2, 3, 4, 5, 6, 7, 8, 9
- File changes summary — all files listed are touched.

**Placeholder scan** — no TBDs, no "add appropriate error handling", no "similar to Task N". Every code step has real code.

**Type consistency** — `Outcome` snake_case values in `apiHealth` bucket counts (`rate_limited`, `timeout`, `circuit_rejected`) intentionally differ from camelCase `totals` keys (`rateLimited`, `timeouts`, `circuitRejected`). This is called out by the summary projection in `getSummary`. `ServiceName` is used identically across all files. `HttpError` / `CircuitOpenError` signatures consistent throughout.

**Scope check** — single cohesive feature. All tasks build one working thing. No over-decomposition.

No issues to fix.

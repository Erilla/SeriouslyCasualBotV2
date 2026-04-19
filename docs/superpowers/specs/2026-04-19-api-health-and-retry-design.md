# API Health & Retry - Design Spec

Shared HTTP client with retry, backoff, timeout, and circuit breaker for the three external services (Raider.io, WarcraftLogs, wowaudit), plus an in-memory health tracker surfaced through `/status`.

**Context:** Today each service hand-rolls raw `fetch` with no retry, no timeout, no rate-limit awareness. Error handling is inconsistent — Raider.io and wowaudit throw on non-2xx, WarcraftLogs swallows and returns `[]`. Nothing tells an operator which service is struggling right now. The question "is something rate-limiting us?" can't be answered without both (a) reliable retry for transient failures so the signal isn't noise, and (b) visibility into what's happening.

**Motivation:** Scheduled tasks like `updateAchievements` make many per-raider calls in sequence. A transient 429 kills the task. Compounded retries across many calls could also push task duration past the next scheduler trigger — we need a circuit breaker to bound total time under sustained upstream failure.

---

## Architecture

Three new concerns, one place each:

```
src/services/
  httpClient.ts      NEW: shared wrapper (timeout + retry + circuit breaker + tracking)
  apiHealth.ts       NEW: in-memory rolling health tracker
  raiderio.ts        refactored to call httpClient
  warcraftlogs.ts    refactored
  wowaudit.ts        refactored
src/commands/
  status.ts          adds "API Health (last hour)" section
```

### `httpClient.ts`

One exported function:

```ts
type ServiceName = 'raiderio' | 'warcraftlogs' | 'wowaudit';

httpRequest<T>(
  service: ServiceName,
  url: string,
  init?: RequestInit,
  opts?: {
    timeoutMs?: number;    // default 10_000
    maxRetries?: number;   // default 2 (3 attempts total)
    parseJson?: boolean;   // default true
  }
): Promise<T>
```

Owns the full request lifecycle: `AbortSignal.timeout`, retry loop, backoff, `Retry-After` honouring, circuit-breaker gating, and recording every attempt into `apiHealth`. Throws a typed `HttpError` on final failure with `{service, status?, attempts, lastError}`. Throws `CircuitOpenError` when breaker is open and request is rejected without a fetch attempt.

Per-service enum (3 known values, not arbitrary strings) keeps the health tracker surface closed and simplifies `/status` rendering.

### `apiHealth.ts`

In-memory per-service state, cleared on restart:

```ts
type Outcome =
  | 'ok'
  | 'retried'            // success, but took >1 attempt
  | 'rate_limited'       // final failure, any attempt saw 429
  | 'timeout'            // final failure, any attempt timed out
  | 'failed'             // final failure, other
  | 'circuit_rejected';  // fast-failed because breaker was open

type MinuteBucket = {
  minuteEpoch: number;   // Math.floor(Date.now() / 60000)
  counts: Record<Outcome, number>;
};

type BreakerState = 'closed' | 'half_open' | 'open';

type ServiceState = {
  buckets: MinuteBucket[];  // ring, max 60 entries (1-hour sliding window)
  lastError?: { msg: string; at: Date; status?: number };
  breaker: {
    state: BreakerState;
    openedAt?: Date;
    consecutiveFailures: number;
  };
};
```

Public API:

```ts
recordOutcome(service: ServiceName, outcome: Outcome, errorDetail?: { msg: string; status?: number }): void;
getSummary(service: ServiceName): ServiceSummary;
getAllSummaries(): Record<ServiceName, ServiceSummary>;

// Breaker hooks (called from httpClient)
isBreakerOpen(service: ServiceName): boolean;
onBreakerTrialResult(service: ServiceName, success: boolean): void;
noteFailure(service: ServiceName): void;  // increments consecutiveFailures, may open breaker
noteSuccess(service: ServiceName): void;  // resets consecutiveFailures
```

`ServiceSummary` shape:

```ts
{
  totals: { ok: number; retried: number; rateLimited: number; timeouts: number; failed: number; circuitRejected: number };
  lastError?: { msg: string; at: Date; status?: number };
  breaker: BreakerState;
}
```

**Rationale for in-memory only:** the question being answered is "what's happening right now" (last hour). Restart visibility loss is acceptable — the bot is up ~100% of the time in normal operation. Avoiding a SQLite table sidesteps migration, retention policy, and a new service for reads. If historical trends become interesting later, that's a future concern.

### Service refactor shape

Each `fetch(url)` call becomes `httpRequest('raiderio', url)` (or the appropriate service). `response.ok` check and JSON parse happen inside `httpRequest`. Callers receive typed data or throw.

Example — `raiderio.ts#getGuildRoster` before/after:

```ts
// BEFORE
const response = await fetch(url);
if (!response.ok) throw new Error(`Raider.io API error: ${response.status} ${response.statusText}`);
const data = (await response.json()) as { members: RaiderIoMember[] };
return data.members.filter(...);

// AFTER
const data = await httpRequest<{ members: RaiderIoMember[] }>('raiderio', url);
return data.members.filter(...);
```

---

## Retry policy

**Attempts:** up to 3 total (initial + 2 retries). Configurable per call via `opts.maxRetries`.

**What retries:**
- HTTP 429 (rate limited)
- HTTP 500, 502, 503, 504
- Network throw (DNS, ECONNRESET, ECONNREFUSED, etc.)
- Timeout (`AbortError` from `AbortSignal.timeout`)

**What does NOT retry (fail fast):**
- 400, 401, 403, 404, 410, 422, any other 4xx — client errors, retrying won't help
- JSON parse errors — response body is broken, not transient

**Backoff schedule:**

| Retry | Computed wait | With jitter |
|-------|---------------|-------------|
| 1     | 500ms         | +random(0–250ms) |
| 2     | 1000ms        | +random(0–500ms) |

If the response includes a `Retry-After` header (seconds or HTTP-date format), use that value **instead** of computed backoff, capped at **30s**. If the value exceeds the cap, treat the call as a final failure immediately rather than blocking the task.

**Worst-case wall time per call:** 10s (initial timeout) + ~0.75s + 10s (retry 1) + ~1.5s + 10s (retry 2) ≈ **32.25s**. Acceptable within scheduler tasks since the scheduler already guards against task overlap via its `running` map.

**Idempotency:** All current calls across the three services are GET-only except WarcraftLogs' OAuth token POST (`grant_type=client_credentials`), which is a stateless credential exchange and safe to retry. `httpRequest` does not gate on method. A code comment documents that adding a non-idempotent call later requires an opt-out.

**Outcome classification (fed to `apiHealth`):**

Every final call outcome increments exactly one of the *result* counters (`ok` / `rate_limited` / `timeout` / `failed` / `circuit_rejected`). The `retried` counter is an **additional flag** incremented alongside `ok` when the success required more than one attempt.

| Path | Counters incremented |
|------|----------------------|
| Success on attempt 1 | `ok` |
| Success on attempt 2 or 3 | `ok` + `retried` |
| Final failure, any attempt saw 429 | `rate_limited` |
| Final failure, any attempt timed out | `timeout` |
| Final failure, other | `failed` |
| Rejected because breaker open | `circuit_rejected` |

This makes `totals.ok` equal to "total successful calls" for simple reporting, while `totals.retried` gives pressure visibility (`"312 ok (2 retried)"` = 312 successes of which 2 needed retries).

---

## Circuit breaker

**Purpose:** prevent a service's sustained failure from causing a scheduled task to consume its entire interval in per-call retries. Concrete risk: if `updateAchievements` (30-min cadence) runs ~300 Raider.io calls and upstream starts 429ing, without a breaker the task could take hours of retry wall time.

**Tracking:** per-service `consecutiveFailures` counter. Incremented on any final failure (`rate_limited`, `timeout`, `failed`). Reset to zero on any final success.

**State transitions:**

```
closed  ──[5 consecutive failures]──▶  open
open    ──[60s cooldown elapsed]───▶  half_open
half_open ──[trial call succeeds]─▶  closed   (consecutiveFailures reset)
half_open ──[trial call fails]────▶  open     (cooldown resets)
```

**Behaviour while open:** `httpRequest` does not attempt a fetch. It records `circuit_rejected` and throws `CircuitOpenError`.

**Half-open:** the very next `httpRequest` call is allowed through as a trial. Subsequent calls during that trial are rejected (treated as open) until the trial resolves. This prevents a burst of parallel calls all bypassing the breaker simultaneously.

**Why this resolves the scheduler-overlap concern:**
- Under sustained upstream failure, ~5 bad calls open the breaker. Remaining calls in the task fail fast in milliseconds, not 32s each.
- The task finishes within its interval. The scheduler's existing `running` guard was always in place to prevent same-task stacking; the breaker is what prevents the task itself from running past its interval.
- The next scheduled trigger starts with the breaker eligible to re-open via half-open, so recovery is automatic without operator intervention.

---

## Error handling & fail-soft boundary

**Default behaviour:** `httpRequest` throws. Callers either let it propagate or catch.

**Who catches:**

1. **`getTrialLogs` (WarcraftLogs)** keeps its existing swallow semantics. Catches `HttpError`/`CircuitOpenError` at its own boundary, calls `logger.warn`, returns `[]`. Preserves today's "empty logs = not found yet" contract for the trial-review flow.
2. **All other service functions** let errors propagate. Matches current behaviour — callers decide.
3. **Scheduler handlers** are already wrapped in a try/catch in `scheduler.ts` that logs and clears `running`. No change. `HttpError` surfaces as a normal `Error` there. `recordTaskRun(name, false, err.message)` continues to populate the existing "Last Roster Sync 2h ago" panel.
4. **User-invoked commands** propagate to the existing `interactionCreate` error handler. Add one branch there: if `err instanceof CircuitOpenError`, reply ephemerally with `"⚠️ {service} is currently unreachable (circuit open). Try again in ~60s."` — friendlier than a raw stack-trace-style message.

---

## `/status` surface

Extend the existing `/status` embed. No new command — keep one pane of glass.

After existing fields, append an "API Health (last hour)" section. One embed field per service (`inline: false`), compact multiline value:

```
Raider.io       🟢 closed  ·  312 ok (2 retried)  ·  0 failed
WarcraftLogs    🟢 closed  ·  12 ok              ·  0 failed
wowaudit        🔴 open    ·  8 ok · 3 failed (2 rate-limited)
                last error: 429 at 16:42 — "Retry-After exceeded 30s cap"
```

**Rendering rules:**
- Emoji prefix: 🟢 `closed`, 🟡 `half_open`, 🔴 `open`
- "retried" subcount only shown when > 0
- Failure breakdown `(N rate-limited)` / `(N timeouts)` / `(N circuit-rejected)` shown only when respective count > 0
- `last error` line only rendered when there has been a failure in the window
- If no calls happened in the window for a service, render `— no traffic`

The existing `/status` uses 10 fields; adding 3 new service fields keeps us well under Discord's 25-field limit.

---

## File changes summary

**New files:**
- `src/services/httpClient.ts` — the wrapper, `HttpError`, `CircuitOpenError`
- `src/services/apiHealth.ts` — tracker + breaker state machine
- `tests/unit/httpClient.test.ts`
- `tests/unit/apiHealth.test.ts`

**Modified files:**
- `src/services/raiderio.ts` — 4 `fetch` calls replaced with `httpRequest<T>('raiderio', url)`
- `src/services/warcraftlogs.ts` — OAuth POST + GraphQL POST routed through `httpRequest`; `getTrialLogs` catches `HttpError`/`CircuitOpenError` at boundary
- `src/services/wowaudit.ts` — 3 `fetch` calls replaced
- `src/commands/status.ts` — append "API Health (last hour)" section, read from `apiHealth.getAllSummaries()`
- `src/events/interactionCreate.ts` — add `CircuitOpenError` branch to error handler for friendlier user-facing message
- `tests/unit/raiderio.test.ts`, `tests/unit/wowaudit.test.ts` — update any 5xx single-call assertions to expect retries

---

## Testing

### `tests/unit/httpClient.test.ts` (new)

Uses `vi.useFakeTimers()` and stubs `global.fetch`:
- Retries on 429 / 500 / 502 / 503 / 504 / network throw / timeout (table-driven)
- Does NOT retry on 400 / 401 / 403 / 404 / 422 / JSON parse error
- Exponential backoff with jitter — assert total waits fall within min/max bands across attempts
- `Retry-After` header (seconds AND HTTP-date) honoured
- `Retry-After` > 30s treated as final failure without blocking
- Timeout via `AbortSignal.timeout` cancels the slow response and counts as retryable
- `HttpError` shape: `{service, status?, attempts, lastError}`
- Circuit breaker: opens after 5 consecutive failures, fails fast while open, half-opens after 60s, closes on trial success, reopens on trial failure
- `apiHealth.recordOutcome` called with correct outcome per path (`ok` / `retried` / `rate_limited` / `timeout` / `failed` / `circuit_rejected`)

### `tests/unit/apiHealth.test.ts` (new)
- Minute buckets accumulate and evict at the 60-min boundary
- `getSummary` aggregates across the window, excludes evicted buckets
- `lastError` updates on failures, persists until overwritten by a newer error
- Breaker state round-trip (closed → open → half_open → closed / open)
- `noteFailure` / `noteSuccess` correctly manage `consecutiveFailures`

### Existing service tests
Minimal churn: they already stub `fetch`. Same stubs continue to work because `httpClient` wraps `fetch`. Any tests that asserted single-call behaviour on 5xx (expecting exactly one failed call) need updating to expect retries. Audit during implementation.

### Integration tests
No new integration tests. API health is a cross-cutting concern best exercised by unit tests.

### Manual verification
After merge, run `/status` in the test guild. Force a 429 by pointing one service at a bad endpoint, confirm the API Health section renders correctly and the breaker opens after 5 failures.

---

## Out of scope

- Persistent (SQLite) storage of API health history. In-memory suffices for the "right now" question. Revisit if trend analysis becomes interesting.
- Per-raider or per-query retry budgets beyond the circuit breaker. The breaker bounds total time per task sufficiently.
- Non-idempotent request handling. No current callers need it. A comment in `httpClient.ts` documents the constraint.
- Retry on `CircuitOpenError`. Caller-level concern; not the wrapper's job.
- Discord-channel alerting when the breaker opens. Could be added later as a `bot-audit` message, but is deferred to avoid scope creep.

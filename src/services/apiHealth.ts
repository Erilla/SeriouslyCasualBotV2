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
    trialInFlight: boolean;
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
const BREAKER_OPEN_THRESHOLD = 5;
const BREAKER_COOLDOWN_MS = 60_000;

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
    breaker: { state: 'closed', consecutiveFailures: 0, trialInFlight: false },
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

function maybeTransitionToHalfOpen(svc: ServiceState): void {
  if (svc.breaker.state === 'open' && svc.breaker.openedAt) {
    const elapsed = Date.now() - svc.breaker.openedAt.getTime();
    if (elapsed >= BREAKER_COOLDOWN_MS) {
      svc.breaker.state = 'half_open';
    }
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
  maybeTransitionToHalfOpen(svc);

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

// Pure predicate: true when the breaker should block a new call. Applies
// the lazy open→half_open transition (a state-machine advance, not a
// trial claim). 'half_open' with a trial already in flight also blocks.
export function isBreakerOpen(service: ServiceName): boolean {
  const svc = state.get(service);
  if (!svc) return false;
  maybeTransitionToHalfOpen(svc);
  if (svc.breaker.state === 'open') return true;
  if (svc.breaker.state === 'half_open' && svc.breaker.trialInFlight) return true;
  return false;
}

// Atomically claim the single half_open trial slot. Returns true if
// claimed (caller is the trial), false otherwise (state is closed, or
// state is half_open but another trial is already in flight).
export function tryClaimTrialSlot(service: ServiceName): boolean {
  const svc = state.get(service);
  if (!svc) return false;
  if (svc.breaker.state !== 'half_open') return false;
  if (svc.breaker.trialInFlight) return false;
  svc.breaker.trialInFlight = true;
  return true;
}

// Lightweight breaker-state query for the httpClient's wasTrial decision.
// Avoids the full bucket aggregation that getSummary does.
export function getBreakerState(service: ServiceName): BreakerState {
  const svc = state.get(service);
  if (!svc) return 'closed';
  maybeTransitionToHalfOpen(svc);
  return svc.breaker.state;
}

export function onBreakerTrialResult(service: ServiceName, success: boolean): void {
  const svc = state.get(service);
  if (!svc) return;
  if (svc.breaker.state !== 'half_open') return;

  svc.breaker.trialInFlight = false;

  if (success) {
    svc.breaker.state = 'closed';
    svc.breaker.openedAt = undefined;
    svc.breaker.consecutiveFailures = 0;
  } else {
    svc.breaker.state = 'open';
    svc.breaker.openedAt = new Date();
  }
}

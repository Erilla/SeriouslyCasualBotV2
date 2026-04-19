import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  recordOutcome,
  getSummary,
  getAllSummaries,
  __resetForTests,
} from '../../src/services/apiHealth.js';
import {
  isBreakerOpen,
  noteFailure,
  noteSuccess,
  onBreakerTrialResult,
  getBreakerState,
  tryClaimTrialSlot,
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

  it('rejects concurrent calls while a half_open trial is in flight', () => {
    for (let i = 0; i < 5; i++) noteFailure('raiderio');
    vi.setSystemTime(new Date('2026-04-19T12:01:00Z'));

    // Observing (pure) doesn't block: state is half_open, no trial yet.
    expect(isBreakerOpen('raiderio')).toBe(false);

    // Claim the trial slot explicitly.
    expect(tryClaimTrialSlot('raiderio')).toBe(true);

    // Concurrent callers now see the breaker as blocked.
    expect(isBreakerOpen('raiderio')).toBe(true);
    expect(tryClaimTrialSlot('raiderio')).toBe(false);

    // Resolving the trial clears the slot and closes the breaker.
    onBreakerTrialResult('raiderio', true);
    expect(getBreakerState('raiderio')).toBe('closed');
    expect(isBreakerOpen('raiderio')).toBe(false);
  });

  it('clears trialInFlight on failed trial so the next cooldown can re-claim', () => {
    for (let i = 0; i < 5; i++) noteFailure('raiderio');
    vi.setSystemTime(new Date('2026-04-19T12:01:00Z'));

    expect(isBreakerOpen('raiderio')).toBe(false);
    expect(tryClaimTrialSlot('raiderio')).toBe(true);
    onBreakerTrialResult('raiderio', false); // trial fails → reopen
    expect(getBreakerState('raiderio')).toBe('open');

    // Past the new cooldown, another trial slot should be claimable.
    vi.setSystemTime(new Date('2026-04-19T12:02:00Z'));
    expect(isBreakerOpen('raiderio')).toBe(false);
    expect(tryClaimTrialSlot('raiderio')).toBe(true);
    expect(tryClaimTrialSlot('raiderio')).toBe(false);
  });
});

describe('apiHealth getBreakerState', () => {
  it('returns current state and applies lazy open->half_open transition without claiming the trial', () => {
    for (let i = 0; i < 5; i++) noteFailure('raiderio');
    expect(getBreakerState('raiderio')).toBe('open');

    vi.setSystemTime(new Date('2026-04-19T12:01:00Z'));
    // Observer transitions state but does not claim the trial slot.
    expect(getBreakerState('raiderio')).toBe('half_open');
    expect(getBreakerState('raiderio')).toBe('half_open');

    // tryClaimTrialSlot is what claims the slot.
    expect(tryClaimTrialSlot('raiderio')).toBe(true);
    expect(tryClaimTrialSlot('raiderio')).toBe(false);
  });
});

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

import { describe, it, expect } from 'vitest';
import {
  compareFingerprints,
  MATCH_PERCENT_THRESHOLD,
  MIN_COMMON_ACHIEVEMENTS,
  type Fingerprint,
} from '../../src/functions/applications/alts/compareFingerprints.js';

/** `identical` achievements share a timestamp; `differing` overlap by id only. */
function build(identical: number, differing: number, offset = 0): [Fingerprint, Fingerprint] {
  const a: Fingerprint = new Map();
  const b: Fingerprint = new Map();
  for (let i = 0; i < identical; i++) {
    a.set(i, 1_700_000_000_000 + i);
    b.set(i, 1_700_000_000_000 + i);
  }
  for (let i = 0; i < differing; i++) {
    const id = 100_000 + i;
    a.set(id, 1_700_000_000_000 + i);
    b.set(id, 1_800_000_000_000 + i + offset);
  }
  return [a, b];
}

describe('compareFingerprints', () => {
  it('reports a same-account pair as a match', () => {
    const [a, b] = build(2069, 2531);
    const result = compareFingerprints(a, b);
    expect(result.identical).toBe(2069);
    expect(result.common).toBe(4600);
    expect(result.percent).toBeCloseTo(44.98, 1);
    expect(result.isMatch).toBe(true);
  });

  it('rejects unrelated characters at the observed noise level', () => {
    const [a, b] = build(83, 2647);
    const result = compareFingerprints(a, b);
    expect(result.percent).toBeLessThan(4);
    expect(result.isMatch).toBe(false);
  });

  it('accepts the weakest genuine match observed (31%)', () => {
    const [a, b] = build(310, 690);
    expect(compareFingerprints(a, b).isMatch).toBe(true);
  });

  it('refuses to judge below the common-achievement floor', () => {
    const [a, b] = build(150, 0);
    const result = compareFingerprints(a, b);
    expect(result.common).toBeLessThan(MIN_COMMON_ACHIEVEMENTS);
    expect(result.percent).toBe(100);
    expect(result.isMatch).toBe(false);
  });

  it('handles empty fingerprints without dividing by zero', () => {
    const result = compareFingerprints(new Map(), new Map());
    expect(result).toEqual({ identical: 0, common: 0, percent: 0, isMatch: false });
  });

  it('exposes the calibrated thresholds', () => {
    expect(MATCH_PERCENT_THRESHOLD).toBe(20);
    expect(MIN_COMMON_ACHIEVEMENTS).toBe(200);
  });
});

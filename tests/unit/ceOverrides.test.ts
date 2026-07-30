import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, initDatabase } from '../../src/database/db.js';
import {
  getCeOverrideCutoff,
  parseCeCutoffDate,
  removeCeOverride,
  setCeOverride,
} from '../../src/functions/guild-info/ceOverrides.js';

describe('CE overrides', () => {
  beforeEach(() => {
    initDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
  });

  it('accepts a real UTC calendar date and normalizes it to an exclusive midnight', () => {
    expect(parseCeCutoffDate('2026-01-21')).toBe('2026-01-21T00:00:00.000Z');
    expect(parseCeCutoffDate('2026-02-29')).toBeNull();
    expect(parseCeCutoffDate('21/01/2026')).toBeNull();
  });

  it('upserts, reads, and removes a raid cutoff', () => {
    setCeOverride('manaforge-omega', '2026-01-21T00:00:00.000Z');
    expect(getCeOverrideCutoff('manaforge-omega')).toBe('2026-01-21T00:00:00.000Z');

    setCeOverride('manaforge-omega', '2026-01-22T00:00:00.000Z');
    expect(getCeOverrideCutoff('manaforge-omega')).toBe('2026-01-22T00:00:00.000Z');

    expect(removeCeOverride('manaforge-omega')).toBe(true);
    expect(getCeOverrideCutoff('manaforge-omega')).toBeNull();
    expect(removeCeOverride('manaforge-omega')).toBe(false);
  });
});

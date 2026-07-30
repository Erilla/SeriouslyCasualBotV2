import { getDatabase } from '../../database/db.js';
import type { CeOverrideRow } from '../../types/index.js';

/**
 * Parse the first UTC calendar date that does not qualify for Cutting Edge.
 * The stored timestamp is always an exclusive UTC midnight boundary.
 */
export function parseCeCutoffDate(input: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) return null;

  const cutoff = new Date(`${input}T00:00:00.000Z`);
  if (Number.isNaN(cutoff.getTime()) || cutoff.toISOString().slice(0, 10) !== input) return null;

  return cutoff.toISOString();
}

export function getCeOverrideCutoff(raidSlug: string): string | null {
  const row = getDatabase()
    .prepare('SELECT raid_slug, cutoff_at FROM achievement_ce_overrides WHERE raid_slug = ?')
    .get(raidSlug) as CeOverrideRow | undefined;
  return row?.cutoff_at ?? null;
}

export function setCeOverride(raidSlug: string, cutoffAt: string): void {
  getDatabase()
    .prepare('INSERT OR REPLACE INTO achievement_ce_overrides (raid_slug, cutoff_at) VALUES (?, ?)')
    .run(raidSlug, cutoffAt);
}

export function removeCeOverride(raidSlug: string): boolean {
  const result = getDatabase()
    .prepare('DELETE FROM achievement_ce_overrides WHERE raid_slug = ?')
    .run(raidSlug);
  return result.changes > 0;
}

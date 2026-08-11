import type { RaidStaticData } from '../../services/raiderio.js';

/**
 * Static data for an expansion is immutable once every raid's EU end date is
 * in the past; while any raid is open-ended it gets a 7-day TTL. Empty
 * payloads (expansion doesn't exist yet) are never fresh.
 *
 * Extracted from achievementsData for the same reason as determineCE: the
 * applicant sweep caches the SAME `static-data:<expansion>` entries under the
 * same freshness rule, and importing achievementsData to get it would drag
 * config, the database and the icon cache into the sweep's graph.
 */
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export function staticDataFreshness(value: RaidStaticData, fetchedAt: Date): boolean {
  const raids = value.raids ?? [];
  if (raids.length === 0) return false;
  const now = Date.now();
  const allEnded = raids.every((r) => r.ends.eu !== null && new Date(r.ends.eu).getTime() < now);
  if (allEnded) return true;
  return now - fetchedAt.getTime() < SEVEN_DAYS_MS;
}

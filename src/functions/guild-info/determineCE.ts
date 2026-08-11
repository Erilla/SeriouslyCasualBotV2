/**
 * The Cutting Edge rule, kept dependency-free.
 *
 * Extracted from achievementsData so the applicant sweep can apply the SAME rule
 * to a candidate's kill history. That module reaches config, the database and the
 * icon cache on import, none of which the sweep's guild-history aggregation
 * needs — and pulling them in would put the whole graph behind an env var.
 *
 * achievementsData re-exports this, so `determineCE` has one definition and both
 * callers agree on what CE means by construction rather than by review.
 */
export function determineCE(args: {
  mythicKilled: number;
  totalBosses: number;
  tierEndsEu: string | null;
  lastBossDefeatedAt: string | null;
}): boolean {
  if (args.mythicKilled < args.totalBosses) return false;
  // No end date, or the tier is still running: a full clear is CE.
  if (!args.tierEndsEu || new Date(args.tierEndsEu).getTime() > Date.now()) return true;
  // Kill timestamp unavailable: assume CE (matches previous behaviour).
  if (!args.lastBossDefeatedAt) return true;
  return new Date(args.lastBossDefeatedAt) < new Date(args.tierEndsEu);
}

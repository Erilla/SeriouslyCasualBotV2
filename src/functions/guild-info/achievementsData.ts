import type { GuildIdentity, GuildRaidSummary, RaidStaticData } from '../../services/raiderio.js';

// ─── Expansion names (moved from updateAchievements.ts) ─────────

export const EXPANSION_NAMES: Record<number, string> = {
  1: 'Classic',
  2: 'The Burning Crusade',
  3: 'Wrath of the Lich King',
  4: 'Mists of Pandaria',
  5: 'Warlords of Draenor',
  6: 'Legion',
  7: 'Battle for Azeroth',
  8: 'Shadowlands',
  9: 'Dragonflight',
  10: 'The War Within',
  11: 'Midnight',
};

export function getExpansionName(id: number): string {
  return EXPANSION_NAMES[id] ?? `Expansion ${id}`;
}

// ─── Identity merge ─────────────────────────────────────────────

export interface MergedStanding {
  identity: GuildIdentity;
  mythicKilled: number;
  totalBosses: number;
  worldRank: number; // 0 = unranked
}

/**
 * Merge per-identity guild summaries into one standing per raid slug: the
 * identity with more mythic kills wins; kill ties go to the better non-zero
 * mythic world rank.
 */
export function mergeGuildSummaries(
  summaries: Array<{ identity: GuildIdentity; summary: GuildRaidSummary }>,
): Map<string, MergedStanding> {
  const merged = new Map<string, MergedStanding>();

  for (const { identity, summary } of summaries) {
    for (const [slug, prog] of Object.entries(summary.raid_progression)) {
      const candidate: MergedStanding = {
        identity,
        mythicKilled: prog.mythic_bosses_killed,
        totalBosses: prog.total_bosses,
        worldRank: summary.raid_rankings[slug]?.mythic.world ?? 0,
      };
      const existing = merged.get(slug);
      if (!existing || beats(candidate, existing)) merged.set(slug, candidate);
    }
  }

  return merged;
}

function beats(a: MergedStanding, b: MergedStanding): boolean {
  if (a.mythicKilled !== b.mythicKilled) return a.mythicKilled > b.mythicKilled;
  if (a.worldRank === 0) return false;
  if (b.worldRank === 0) return true;
  return a.worldRank < b.worldRank;
}

// ─── Cutting Edge ───────────────────────────────────────────────

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

// ─── Cache freshness for static data ────────────────────────────

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Static data for an expansion is immutable once every raid's EU end date is
 * in the past; while any raid is open-ended it gets a 7-day TTL. Empty
 * payloads (expansion doesn't exist yet) are never fresh.
 */
export function staticDataFreshness(value: RaidStaticData, fetchedAt: Date): boolean {
  const raids = value.raids ?? [];
  if (raids.length === 0) return false;
  const now = Date.now();
  const allEnded = raids.every((r) => r.ends.eu !== null && new Date(r.ends.eu).getTime() < now);
  if (allEnded) return true;
  return now - fetchedAt.getTime() < SEVEN_DAYS_MS;
}

// ─── Icons ──────────────────────────────────────────────────────

// Verified against zamimg (2026-07-29). Expansions absent here fall back to
// their newest raid's icon from static data.
const EXPANSION_ICONS: Record<number, string> = {
  4: 'expansionicon_mistsofpandaria',
  5: 'achievement_zone_draenor_01',
  6: 'achievement_faction_legionfall',
  7: 'inv_heartofazeroth',
  8: 'inv_progenitor_runevessel',
};

export function expansionIconName(
  expansionId: number,
  newestRaidIcon: string | null,
): string | null {
  return EXPANSION_ICONS[expansionId] ?? newestRaidIcon;
}

export function zamimgUrl(iconName: string): string {
  return `https://wow.zamimg.com/images/wow/icons/large/${iconName}.jpg`;
}

/** "/images/wow/icons/large/foo.jpg" → "foo" */
export function iconNameFromUrl(iconUrl: string): string | null {
  const base = iconUrl.split('/').pop();
  if (!base) return null;
  const name = base.replace(/\.[a-z]+$/i, '');
  return name.length > 0 ? name : null;
}

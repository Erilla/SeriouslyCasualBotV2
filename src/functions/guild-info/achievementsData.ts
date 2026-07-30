import type { GuildIdentity, GuildRaidSummary, RaidStaticData } from '../../services/raiderio.js';
import { getDatabase } from '../../database/db.js';
import { config } from '../../config.js';
import {
  getGuildRaidEncounters,
  getGuildRaidSummary,
  getLiveRaidProgress,
  getRaidStaticData,
} from '../../services/raiderio.js';
import { FOREVER, getCachedOrFetch, getIconOrFetch } from '../../services/apiCache.js';
import { HttpError } from '../../services/httpClient.js';
import type { AchievementsManualRow } from '../../types/index.js';
import { getCeOverrideCutoff } from './ceOverrides.js';

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

// Raider.IO omits raid icons for all Legion raids. These use the matching
// Blizzard achievement art and are fetched through the usual icon cache.
const LEGION_RAID_ICONS: Record<string, string> = {
  'the-emerald-nightmare': 'achievement_emeraldnightmare_xavius',
  'the-nighthold': 'achievement_thenighthold',
  'trial-of-valor': 'achievement_raid_trialofvalor',
  'tomb-of-sargeras': 'achievement_boss_kiljaeden2',
  'antorus-the-burning-throne': 'achievement_boss_argus_worldsoul',
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

// ─── Model ─────────────────────────────────────────────────────

export interface AchievementBossRow {
  name: string;
  icon: string | null;
  pulls: number;
  bestPercent: number;
  defeated: boolean;
}

export interface AchievementRaidRow {
  raid: string;
  icon: string | null;
  progress: string;
  isCE: boolean;
  result: string;
  bosses?: AchievementBossRow[];
}

export interface AchievementsSection {
  expansionLabel: string;
  expansionIcon: string | null;
  rows: AchievementRaidRow[];
  isCurrent?: boolean;
}

export interface AchievementsModel {
  sections: AchievementsSection[];
  icons: Map<string, Buffer>;
}

const FIRST_API_EXPANSION = 6;

type StaticRaid = RaidStaticData['raids'][number];

export function raidIconName(raid: Pick<StaticRaid, 'slug' | 'icon'>): string | null {
  return raid.icon ?? LEGION_RAID_ICONS[raid.slug] ?? null;
}

/**
 * Assemble static raid data, live guild standings, manual achievements, and
 * their icon buffers. Fetch failures propagate so callers never render a
 * partial model.
 */
export async function buildAchievementsModel(): Promise<AchievementsModel> {
  const staticByExpansion = new Map<number, RaidStaticData>();
  for (let expansion = FIRST_API_EXPANSION; ; expansion++) {
    let data: RaidStaticData;
    try {
      data = await getCachedOrFetch(`static-data:${expansion}`, staticDataFreshness, () =>
        getRaidStaticData(expansion),
      );
    } catch (error) {
      // Raider.IO signals that this generated expansion id is beyond its
      // catalogue with a specific HTTP 400 response rather than an empty raids
      // array. Other 400s must fail the refresh rather than silently posting a
      // partial achievements image.
      if (
        error instanceof HttpError &&
        error.service === 'raiderio' &&
        error.status === 400 &&
        error.responseMessage === 'Requested unsupported expansion_id'
      ) {
        break;
      }
      throw error;
    }
    if (data.raids.length === 0) break;
    staticByExpansion.set(expansion, data);
  }

  const expansionIds = [...staticByExpansion.keys()];
  const currentExpansion = Math.max(...expansionIds);
  const summaries = [] as Array<{ identity: GuildIdentity; summary: GuildRaidSummary }>;
  for (const identity of config.raiderIoGuilds) {
    summaries.push({ identity, summary: await getGuildRaidSummary(identity, expansionIds) });
  }
  const standings = mergeGuildSummaries(summaries);

  const iconNames = new Set<string>();
  const sections: AchievementsSection[] = [];

  for (const expansion of [...expansionIds].sort((a, b) => b - a)) {
    const raids = staticByExpansion
      .get(expansion)!
      .raids.filter((raid) => !raid.slug.startsWith('fated-') && !raid.slug.startsWith('awakened-'))
      .sort(byEndDateDescending);
    const rows: AchievementRaidRow[] = [];

    for (const raid of raids) {
      const standing = standings.get(raid.slug);
      if (!standing || standing.mythicKilled === 0) continue;

      const row: AchievementRaidRow = {
        raid: raid.name,
        icon: raidIconName(raid),
        progress: `${standing.mythicKilled}/${standing.totalBosses}M`,
        isCE: await resolveCE(raid, standing),
        result: standing.worldRank > 0 ? `WR ${standing.worldRank}` : '',
      };

      if (expansion === currentExpansion && standing.mythicKilled < standing.totalBosses) {
        row.bosses = await resolveLiveBreakdown(raid.slug, standing.identity);
      }

      if (row.icon) iconNames.add(row.icon);
      for (const boss of row.bosses ?? []) if (boss.icon) iconNames.add(boss.icon);
      rows.push(row);
    }

    if (rows.length === 0) continue;
    const expansionIcon = expansionIconName(expansion, rows[0]?.icon ?? null);
    if (expansionIcon) iconNames.add(expansionIcon);
    sections.push({
      expansionLabel: getExpansionName(expansion),
      expansionIcon,
      rows,
      isCurrent: expansion === currentExpansion,
    });
  }

  for (const section of buildManualSections()) {
    if (section.expansionIcon) iconNames.add(section.expansionIcon);
    for (const row of section.rows) if (row.icon) iconNames.add(row.icon);
    sections.push(section);
  }

  const icons = new Map<string, Buffer>();
  for (const name of iconNames) {
    icons.set(name, await getIconOrFetch(name, zamimgUrl(name)));
  }

  return { sections, icons };
}

function byEndDateDescending(a: StaticRaid, b: StaticRaid): number {
  const endA = a.ends.eu ?? '';
  const endB = b.ends.eu ?? '';
  if (!endA && !endB) return 0;
  if (!endA) return -1;
  if (!endB) return 1;
  return endB.localeCompare(endA);
}

async function resolveCE(raid: StaticRaid, standing: MergedStanding): Promise<boolean> {
  if (standing.mythicKilled < standing.totalBosses) return false;

  const tierEndsEu = getCeOverrideCutoff(raid.slug) ?? raid.ends.eu;
  const tierEnded = tierEndsEu !== null && new Date(tierEndsEu).getTime() < Date.now();
  if (!tierEnded) return true;

  const encounters = await getCachedOrFetch(
    `encounters:${standing.identity.realm}:${raid.slug}`,
    FOREVER,
    () => getGuildRaidEncounters(standing.identity, raid.slug),
  );
  const lastBossSlug = raid.encounters[raid.encounters.length - 1]?.slug;
  const lastKill = encounters.find((encounter) => encounter.slug === lastBossSlug);
  return determineCE({
    mythicKilled: standing.mythicKilled,
    totalBosses: standing.totalBosses,
    tierEndsEu,
    lastBossDefeatedAt: lastKill?.defeatedAt ?? null,
  });
}

async function resolveLiveBreakdown(
  raidSlug: string,
  identity: GuildIdentity,
): Promise<AchievementBossRow[]> {
  const bosses = await getLiveRaidProgress(identity, raidSlug);
  return [...bosses]
    .sort((a, b) => a.boss.ordinal - b.boss.ordinal)
    .map((boss) => ({
      name: boss.boss.name,
      icon: boss.boss.iconUrl ? iconNameFromUrl(boss.boss.iconUrl) : null,
      pulls: boss.pullCount,
      bestPercent: boss.bestPercent,
      defeated: Boolean(boss.isDefeated),
    }));
}

function buildManualSections(): AchievementsSection[] {
  const rows = getDatabase()
    .prepare('SELECT * FROM achievements_manual ORDER BY expansion, sort_order')
    .all() as AchievementsManualRow[];
  const grouped = new Map<number, AchievementsManualRow[]>();

  for (const row of rows) {
    const expansionRows = grouped.get(row.expansion) ?? [];
    expansionRows.push(row);
    grouped.set(row.expansion, expansionRows);
  }

  const sections: AchievementsSection[] = [];
  for (const [expansion, expansionRows] of grouped) {
    sections.push({
      expansionLabel: getExpansionName(expansion),
      expansionIcon: expansionIconName(expansion, null),
      isCurrent: false,
      rows: expansionRows
        .map((row) => ({
          raid: row.raid,
          icon: row.icon,
          progress: row.progress,
          isCE: row.result.includes('CE'),
          result: row.result
            .replace(/\*\*/g, '')
            .replace(/^CE\s*/, '')
            .trim(),
        }))
        .reverse(),
    });
  }

  return sections.reverse();
}

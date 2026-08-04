import { config } from '../config.js';
import { httpRequest, CircuitOpenError, HttpError } from './httpClient.js';
import type { RaiderIoCharacter } from '../functions/applications/raiderIoName.js';

const BASE_URL = 'https://raider.io/api/v1';
const ROSTER_RANKS = [0, 1, 3, 4, 5, 7];

export interface RaiderIoMember {
  rank: number;
  character: {
    name: string;
    realm: string;
    region: string;
    class: string;
  };
}

export interface RaidRanking {
  rank: number;
  guild: {
    name: string;
    realm: string;
    region: string;
  };
  encountersDefeated: number;
  encountersTotal: number;
}

export interface RaidStaticData {
  raids: Array<{
    id: number;
    slug: string;
    name: string;
    short_name?: string;
    icon?: string;
    expansion_id: number;
    starts: { us: string | null; eu: string | null };
    ends: { us: string | null; eu: string | null };
    encounters: Array<{
      id: number;
      slug: string;
      name: string;
    }>;
  }>;
}

export interface MythicPlusRun {
  dungeon: string;
  short_name: string;
  mythic_level: number;
  num_keystone_upgrades: number;
  score: number;
}

export async function getGuildRoster(): Promise<RaiderIoMember[]> {
  const url = `${BASE_URL}/guilds/profile?region=eu&realm=silvermoon&name=seriouslycasual&fields=members`;
  const data = await httpRequest<{ members: RaiderIoMember[] }>('raiderio', url);
  return data.members.filter((m) => ROSTER_RANKS.includes(m.rank));
}

export async function getRaidRankings(raidSlug: string): Promise<RaidRanking[]> {
  const url = `${BASE_URL}/raiding/raid-rankings?raid=${raidSlug}&difficulty=mythic&region=world&guilds=${config.raiderIoGuildIds}&limit=50`;
  const data = await httpRequest<{ raidRankings: RaidRanking[] }>('raiderio', url);
  return data.raidRankings;
}

export async function getRaidStaticData(expansionId: number): Promise<RaidStaticData> {
  const url = `${BASE_URL}/raiding/static-data?expansion_id=${expansionId}`;
  return httpRequest<RaidStaticData>('raiderio', url);
}

export async function getPreviousWeekProfile(
  region: string,
  realm: string,
  name: string,
): Promise<{ runs: MythicPlusRun[]; lastCrawledAt: string | null }> {
  const url = `${BASE_URL}/characters/profile?region=${region}&realm=${realm}&name=${encodeURIComponent(name)}&fields=mythic_plus_previous_weekly_highest_level_runs`;
  const data = await httpRequest<{
    mythic_plus_previous_weekly_highest_level_runs?: MythicPlusRun[];
    last_crawled_at?: string;
  }>('raiderio', url);
  return {
    runs: data.mythic_plus_previous_weekly_highest_level_runs ?? [],
    lastCrawledAt: data.last_crawled_at ?? null,
  };
}

export async function getWeeklyMythicPlusRuns(
  region: string,
  realm: string,
  name: string,
): Promise<MythicPlusRun[]> {
  return (await getPreviousWeekProfile(region, realm, name)).runs;
}

export interface GuildIdentity {
  region: string;
  realm: string;
  name: string;
}

export interface RaidProgressionEntry {
  summary: string;
  total_bosses: number;
  mythic_bosses_killed: number;
}

export interface RaidRankingRanks {
  world: number;
  region: number;
  realm: number;
}

export interface GuildRaidSummary {
  raid_progression: Record<string, RaidProgressionEntry>;
  raid_rankings: Record<string, { mythic: RaidRankingRanks }>;
}

export interface RaidEncounterKill {
  slug: string;
  name: string;
  defeatedAt: string;
}

export interface LiveBossProgress {
  boss: {
    name: string;
    slug: string;
    ordinal: number;
    iconUrl: string | null;
  };
  pullCount: number;
  bestPercent: number;
  // The live API returns 1 for defeated bosses and false for alive ones.
  isDefeated: boolean | number;
}

function identityParams(identity: GuildIdentity): string {
  return `region=${identity.region}&realm=${encodeURIComponent(identity.realm)}&name=${encodeURIComponent(identity.name)}`;
}

/** Progression + mythic rankings for every raid of the given expansions, one call. */
export async function getGuildRaidSummary(
  identity: GuildIdentity,
  expansionIds: number[],
): Promise<GuildRaidSummary> {
  const params = expansionIds.join(':');
  const fields = encodeURIComponent(`raid_progression:${params},raid_rankings:${params}`);
  const url = `${BASE_URL}/guilds/profile?${identityParams(identity)}&fields=${fields}`;
  const data = await httpRequest<Partial<GuildRaidSummary>>('raiderio', url);
  return {
    raid_progression: data.raid_progression ?? {},
    raid_rankings: data.raid_rankings ?? {},
  };
}

/** Per-boss mythic first-kill timestamps for one raid. */
export async function getGuildRaidEncounters(
  identity: GuildIdentity,
  raidSlug: string,
): Promise<RaidEncounterKill[]> {
  const fields = encodeURIComponent(`raid_encounters:${raidSlug}:mythic`);
  const url = `${BASE_URL}/guilds/profile?${identityParams(identity)}&fields=${fields}`;
  const data = await httpRequest<{ raid_encounters?: RaidEncounterKill[] }>('raiderio', url);
  return data.raid_encounters ?? [];
}

/**
 * Live per-boss pull counts / best % for one raid (mythic, pulls until first
 * kill). Note the live-tracking endpoint names its guild parameter `guild`,
 * not `name`, so it can't reuse identityParams().
 */
export async function getLiveRaidProgress(
  identity: GuildIdentity,
  raidSlug: string,
): Promise<LiveBossProgress[]> {
  const url =
    `${BASE_URL}/live-tracking/guild/raid-progress?raid=${raidSlug}&difficulty=mythic` +
    `&region=${identity.region}&realm=${encodeURIComponent(identity.realm)}` +
    `&guild=${encodeURIComponent(identity.name)}&period=until_kill`;
  const data = await httpRequest<{ bosses?: LiveBossProgress[] }>('raiderio', url);
  return data.bosses ?? [];
}

export interface CharacterGuild {
  name: string;
  realm: string;
}

export interface CharacterSummary {
  className: string | null;
  guild: CharacterGuild | null;
}

interface ProfileResponse {
  class?: string;
  guild?: { name: string; realm: string };
  raid_progression?: Record<string, { mythic_bosses_killed?: number }>;
}

function profileUrl(c: RaiderIoCharacter, fields: string): string {
  return (
    `${BASE_URL}/characters/profile?region=${encodeURIComponent(c.region)}` +
    `&realm=${encodeURIComponent(c.realm)}&name=${encodeURIComponent(c.name)}&fields=${fields}`
  );
}

/**
 * These two lookups look decorative (a class name, a guild label) but they GATE
 * THE ALT SWEEP: `discoverAlts` seeds its guild frontier exclusively from
 * `getCharacterSummary().guild` and from `getCharacterGuild`. Swallowing a rate
 * limit here empties the frontier, so the BFS never runs, `truncated` stays
 * false, and the message publishes an affirmative "only the declared characters
 * exist" while the Blizzard fingerprint — which was working — was never given a
 * single guild to walk.
 *
 * So a 429 or an open circuit is RETHROWN, exactly as `blizzard.ts` does at its
 * two equivalent sites: the job runner pauses and resumes on both. Ordinary
 * unavailability (404 private/renamed, 403, 500) still swallows to null, which
 * genuinely means "unknown for this character" and must not pause a job.
 *
 * `status` alone is insufficient: httpRequest's retry-exhaustion path reports
 * the LAST status seen, so 429/429/503 arrives as 503. `retryAfterMs` is set
 * whenever any attempt was rate-limited with a usable wait.
 */
function rethrowIfRateLimited(error: unknown): void {
  if (error instanceof CircuitOpenError) throw error;
  if (error instanceof HttpError && (error.status === 429 || error.retryAfterMs !== undefined)) {
    throw error;
  }
}

/**
 * The guild carries its OWN realm, frequently not the character's:
 * Driptinus-Argent Dawn is in Rancour-Draenor, and querying the roster on the
 * character's realm returns "Could not find requested guild".
 */
export async function getCharacterGuild(c: RaiderIoCharacter): Promise<CharacterGuild | null> {
  try {
    const data = await httpRequest<ProfileResponse>('raiderio', profileUrl(c, 'guild'));
    return data.guild ? { name: data.guild.name, realm: data.guild.realm } : null;
  } catch (error) {
    rethrowIfRateLimited(error);
    return null;
  }
}

export async function getCharacterSummary(c: RaiderIoCharacter): Promise<CharacterSummary | null> {
  try {
    const data = await httpRequest<ProfileResponse>('raiderio', profileUrl(c, 'guild'));
    return {
      className: data.class ?? null,
      guild: data.guild ? { name: data.guild.name, realm: data.guild.realm } : null,
    };
  } catch (error) {
    rethrowIfRateLimited(error);
    return null;
  }
}

/**
 * Mythic bosses killed in the CURRENT expansion — a cheap prioritiser for which
 * alts deserve a WCL sweep. It cannot gate the sweep: the field covers one
 * expansion, lags the crawl, and counts kills but not wipe progress.
 *
 * Unlike the two lookups above this one really is only a prioritiser, so it
 * keeps swallowing everything — including a 429. A rate limit here costs a
 * slightly worse ordering of which alts get swept, never a false absence.
 */
export async function getMythicKillCount(c: RaiderIoCharacter): Promise<number> {
  try {
    const data = await httpRequest<ProfileResponse>('raiderio', profileUrl(c, 'raid_progression'));
    return Object.values(data.raid_progression ?? {}).reduce(
      (sum, raid) => sum + (raid.mythic_bosses_killed ?? 0),
      0,
    );
  } catch {
    return 0;
  }
}

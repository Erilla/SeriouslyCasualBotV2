import { config } from '../config.js';
import { httpRequest } from './httpClient.js';

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

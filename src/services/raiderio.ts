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

export async function getWeeklyMythicPlusRuns(
  region: string,
  realm: string,
  name: string,
): Promise<MythicPlusRun[]> {
  const url = `${BASE_URL}/characters/profile?region=${region}&realm=${realm}&name=${encodeURIComponent(name)}&fields=mythic_plus_previous_weekly_highest_level_runs`;
  const data = await httpRequest<{
    mythic_plus_previous_weekly_highest_level_runs: MythicPlusRun[];
  }>('raiderio', url);
  return data.mythic_plus_previous_weekly_highest_level_runs;
}

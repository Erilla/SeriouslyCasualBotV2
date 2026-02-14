import axios from 'axios';
import { config } from '../config.js';
import { logger } from './logger.js';

const BASE_URL = 'https://raider.io/api/v1';

const api = axios.create({ timeout: 10_000 });

export interface RaidStaticData {
    raids: Array<{
        slug: string;
        name: string;
        encounters: Array<{ slug: string; name: string }>;
        ends: { eu: string | null; us: string | null };
    }>;
}

export interface RaidRankingsData {
    raidRankings: Array<{
        rank: number;
        encountersDefeated: Array<{
            slug: string;
            firstDefeated: string;
        }>;
    }>;
}

export interface CharacterProfile {
    name: string;
    realm: string;
    region: string;
    mythic_plus_previous_weekly_highest_level_runs?: Array<{
        dungeon: string;
        mythic_level: number;
        num_keystone_upgrades: number;
        score: number;
    }>;
}

export interface GuildMember {
    rank: number;
    character: {
        name: string;
        realm: string;
        region: string;
        class: string;
        active_spec_name: string;
        active_spec_role: string;
        profile_url: string;
    };
}

/**
 * Get raid rankings for a specific raid slug.
 */
export async function getRaidRankings(raidSlug: string): Promise<RaidRankingsData | null> {
    try {
        const url = `${BASE_URL}/raiding/raid-rankings?raid=${raidSlug}&difficulty=mythic&region=world&guilds=${config.raiderioGuildId}&limit=50`;
        const response = await api.get<RaidRankingsData>(url);
        return response.data;
    } catch (error) {
        logger.warn(`[RaiderIO] getRaidRankings failed: ${error}`).catch(() => {});
        return null;
    }
}

/**
 * Get static raid data for an expansion.
 * Returns null if the expansion doesn't exist (400 from API).
 */
export async function getRaidStaticData(expansionId: number): Promise<RaidStaticData | null> {
    try {
        const url = `${BASE_URL}/raiding/static-data?expansion_id=${expansionId}`;
        const response = await api.get<RaidStaticData>(url);
        return response.data;
    } catch (error) {
        logger.warn(`[RaiderIO] getRaidStaticData failed: ${error}`).catch(() => {});
        return null;
    }
}

/**
 * Get a character's previous week's highest M+ runs.
 */
export async function getPreviousWeeklyHighestMythicPlusRun(
    region: string,
    realm: string,
    name: string,
): Promise<CharacterProfile | null> {
    try {
        const url = `${BASE_URL}/characters/profile?region=${region}&realm=${realm}&name=${encodeURIComponent(name)}&fields=mythic_plus_previous_weekly_highest_level_runs`;
        const response = await api.get<CharacterProfile>(url);
        return response.data;
    } catch (error) {
        logger.warn(`[RaiderIO] getPreviousWeeklyHighestMythicPlusRun failed for ${name}: ${error}`).catch(() => {});
        return null;
    }
}

/**
 * Get guild roster from Raider.io, filtered to raider ranks.
 * Ranks: 0 (GM), 1 (Officer), 3, 4, 5, 7 (Raider ranks).
 */
export async function getGuildRoster(
    region: string = config.guildRegion,
    realm: string = config.guildRealm,
    guildName: string = config.guildName,
): Promise<GuildMember[]> {
    try {
        const url = `${BASE_URL}/guilds/profile?region=${region}&realm=${realm}&name=${guildName}&fields=members`;
        const response = await api.get<{ members: GuildMember[] }>(url);
        return response.data.members.filter((m) => [0, 1, 3, 4, 5, 7].includes(m.rank));
    } catch (error) {
        logger.warn(`[RaiderIO] getGuildRoster failed: ${error}`).catch(() => {});
        return [];
    }
}

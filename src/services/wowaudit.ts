import axios from 'axios';
import { config } from '../config.js';
import { logger } from './logger.js';

const BASE_URL = 'https://wowaudit.com/v1';

const api = axios.create({ timeout: 10_000 });

export interface WowAuditCharacterData {
    name: string;
    data: {
        dungeons_done?: Array<{ level: string | number }>;
        vault_options?: {
            raids: { option_1: string | null; option_2: string | null; option_3: string | null } | null;
            dungeons: { option_1: string | null; option_2: string | null; option_3: string | null } | null;
            world: { option_1: string | null; option_2: string | null; option_3: string | null } | null;
        };
    } | null;
}

interface WowAuditRaid {
    id: number;
    date: string;
    title: string;
}

function getHeaders() {
    return {
        accept: 'application/json',
        Authorization: config.wowAuditApiSecret,
    };
}

/**
 * Get upcoming raids from WoW Audit.
 */
export async function getUpcomingRaids(): Promise<WowAuditRaid[] | null> {
    try {
        const response = await api.get<{ raids: WowAuditRaid[] }>(
            `${BASE_URL}/raids?include_past=false`,
            { headers: getHeaders() },
        );
        return response.data.raids;
    } catch (error) {
        logger.warn(`[WowAudit] getUpcomingRaids failed: ${error}`).catch(() => {});
        return null;
    }
}

/**
 * Get details for a specific raid.
 */
export async function getRaidDetails(id: number): Promise<unknown> {
    try {
        const response = await api.get(
            `${BASE_URL}/raids/${id}`,
            { headers: getHeaders() },
        );
        return response.data;
    } catch (error) {
        logger.warn(`[WowAudit] getRaidDetails failed for id ${id}: ${error}`).catch(() => {});
        return null;
    }
}

/**
 * Get historical character data for the previous period.
 * Returns M+ dungeons done and Great Vault options per character.
 */
export async function getHistoricalData(): Promise<WowAuditCharacterData[] | null> {
    try {
        const currentPeriod = await getCurrentPeriod();
        if (currentPeriod === null) return null;

        const previousPeriod = currentPeriod - 1;
        const response = await api.get<{ characters: WowAuditCharacterData[] }>(
            `${BASE_URL}/historical_data?period=${previousPeriod}`,
            { headers: getHeaders() },
        );
        return response.data.characters;
    } catch (error) {
        logger.warn(`[WowAudit] getHistoricalData failed: ${error}`).catch(() => {});
        return null;
    }
}

/**
 * Get the current WoW Audit period number.
 */
export async function getCurrentPeriod(): Promise<number | null> {
    try {
        const response = await api.get<{ current_period: number }>(
            `${BASE_URL}/period`,
            { headers: getHeaders() },
        );
        return response.data.current_period;
    } catch (error) {
        logger.warn(`[WowAudit] getCurrentPeriod failed: ${error}`).catch(() => {});
        return null;
    }
}

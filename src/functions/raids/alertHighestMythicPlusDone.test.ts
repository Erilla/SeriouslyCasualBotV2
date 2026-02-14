import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WowAuditCharacterData } from '../../services/wowaudit.js';

// Mock wowaudit so getHistoricalData doesn't make real calls
vi.mock('../../services/wowaudit.js', () => ({
    getHistoricalData: vi.fn().mockResolvedValue(null),
}));

// Mock logger
vi.mock('../../services/logger.js', () => ({
    logger: { warn: vi.fn().mockResolvedValue(undefined), info: vi.fn().mockResolvedValue(undefined) },
}));

// Mock utils
vi.mock('../../utils.js', () => ({
    fetchTextChannel: vi.fn().mockResolvedValue(null),
}));

import { getPreviousWeekMythicPlusMessage, getPreviousWeeklyGreatVaultMessage } from './alertHighestMythicPlusDone.js';

describe('getPreviousWeekMythicPlusMessage', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('returns fallback when data is null', async () => {
        const result = await getPreviousWeekMythicPlusMessage(null);
        expect(result.content).toContain('No data available');
        expect(result.files).toEqual([]);
    });

    it('returns sorted output with Buffer attachment for valid data', async () => {
        const data: WowAuditCharacterData[] = [
            { name: 'Zara', data: { dungeons_done: [{ level: 12 }, { level: 15 }, { level: 10 }] } },
            { name: 'Alpha', data: { dungeons_done: [{ level: 8 }] } },
        ];

        const result = await getPreviousWeekMythicPlusMessage(data);
        expect(result.content).toBe('Highest Mythic+ Runs last week');
        expect(result.files.length).toBe(1);
        expect(result.files[0].attachment).toBeInstanceOf(Buffer);

        const text = result.files[0].attachment.toString('utf-8');
        // Alpha should come before Zara (sorted by name)
        const alphaIndex = text.indexOf('Alpha');
        const zaraIndex = text.indexOf('Zara');
        expect(alphaIndex).toBeLessThan(zaraIndex);
        // Zara's dungeons should be sorted descending
        expect(text).toContain('Zara: [15,12,10]');
    });

    it('handles characters with null data', async () => {
        const data: WowAuditCharacterData[] = [
            { name: 'NullChar', data: null },
        ];

        const result = await getPreviousWeekMythicPlusMessage(data);
        const text = result.files[0].attachment.toString('utf-8');
        expect(text).toContain('NullChar: [No Data]');
    });
});

describe('getPreviousWeeklyGreatVaultMessage', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('returns fallback when data is null', async () => {
        const result = await getPreviousWeeklyGreatVaultMessage(null);
        expect(result.content).toContain('No data available');
        expect(result.files).toEqual([]);
    });

    it('returns padded table for valid data', async () => {
        const data: WowAuditCharacterData[] = [
            {
                name: 'TestChar',
                data: {
                    vault_options: {
                        raids: { option_1: '616', option_2: '613', option_3: null },
                        dungeons: { option_1: '619', option_2: null, option_3: null },
                        world: null,
                    },
                },
            },
        ];

        const result = await getPreviousWeeklyGreatVaultMessage(data);
        expect(result.content).toBe('Great Vaults last week');
        expect(result.files.length).toBe(1);

        const text = result.files[0].attachment.toString('utf-8');
        expect(text).toContain('TestChar');
        expect(text).toContain('616');
        expect(text).toContain('619');
    });

    it('handles null vault options gracefully', async () => {
        const data: WowAuditCharacterData[] = [
            { name: 'NullVault', data: { vault_options: undefined } },
        ];

        const result = await getPreviousWeeklyGreatVaultMessage(data);
        const text = result.files[0].attachment.toString('utf-8');
        expect(text).toContain('NullVault');
        expect(text).toContain('No Data');
    });
});

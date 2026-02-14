import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGet = vi.hoisted(() => vi.fn());

// Mock logger
vi.mock('./logger.js', () => ({
    logger: { warn: vi.fn().mockResolvedValue(undefined) },
}));

// Mock config
vi.mock('../config.js', () => ({
    config: {
        raiderioGuildId: 'test-guild-id',
        guildRegion: 'eu',
        guildRealm: 'silvermoon',
        guildName: 'testguild',
    },
}));

// Mock axios
vi.mock('axios', () => ({
    default: {
        create: () => ({ get: mockGet }),
    },
}));

import { getRaidRankings, getRaidStaticData, getPreviousWeeklyHighestMythicPlusRun, getGuildRoster } from './raiderio.js';

describe('getRaidRankings', () => {
    beforeEach(() => {
        mockGet.mockReset();
    });

    it('returns data on success', async () => {
        const data = { raidRankings: [{ rank: 500, encountersDefeated: [] }] };
        mockGet.mockResolvedValue({ data });

        const result = await getRaidRankings('test-raid');
        expect(result).toEqual(data);
        expect(mockGet).toHaveBeenCalledWith(expect.stringContaining('test-raid'));
    });

    it('returns null on error', async () => {
        mockGet.mockRejectedValue(new Error('Network error'));
        const result = await getRaidRankings('bad-raid');
        expect(result).toBeNull();
    });
});

describe('getRaidStaticData', () => {
    beforeEach(() => {
        mockGet.mockReset();
    });

    it('returns data on success', async () => {
        const data = { raids: [] };
        mockGet.mockResolvedValue({ data });

        const result = await getRaidStaticData(6);
        expect(result).toEqual(data);
        expect(mockGet).toHaveBeenCalledWith(expect.stringContaining('expansion_id=6'));
    });

    it('returns null on error', async () => {
        mockGet.mockRejectedValue(new Error('Bad request'));
        const result = await getRaidStaticData(999);
        expect(result).toBeNull();
    });
});

describe('getPreviousWeeklyHighestMythicPlusRun', () => {
    beforeEach(() => {
        mockGet.mockReset();
    });

    it('returns data on success', async () => {
        const data = { name: 'TestChar', realm: 'Silvermoon', region: 'eu' };
        mockGet.mockResolvedValue({ data });

        const result = await getPreviousWeeklyHighestMythicPlusRun('eu', 'silvermoon', 'TestChar');
        expect(result).toEqual(data);
    });

    it('returns null on error', async () => {
        mockGet.mockRejectedValue(new Error('Not found'));
        const result = await getPreviousWeeklyHighestMythicPlusRun('eu', 'silvermoon', 'Missing');
        expect(result).toBeNull();
    });

    it('URI-encodes character name in URL', async () => {
        mockGet.mockResolvedValue({ data: {} });
        await getPreviousWeeklyHighestMythicPlusRun('eu', 'silvermoon', 'Spëcial Char');
        expect(mockGet).toHaveBeenCalledWith(expect.stringContaining('Sp%C3%ABcial%20Char'));
    });
});

describe('getGuildRoster', () => {
    beforeEach(() => {
        mockGet.mockReset();
    });

    it('filters to valid raider ranks', async () => {
        const members = [
            { rank: 0, character: { name: 'GM' } },
            { rank: 1, character: { name: 'Officer' } },
            { rank: 2, character: { name: 'Social' } },
            { rank: 3, character: { name: 'Raider3' } },
            { rank: 4, character: { name: 'Raider4' } },
            { rank: 5, character: { name: 'Raider5' } },
            { rank: 6, character: { name: 'Casual' } },
            { rank: 7, character: { name: 'Raider7' } },
        ];
        mockGet.mockResolvedValue({ data: { members } });

        const result = await getGuildRoster('eu', 'silvermoon', 'testguild');
        expect(result.length).toBe(6);
        const names = result.map((m) => m.character.name);
        expect(names).toContain('GM');
        expect(names).toContain('Officer');
        expect(names).not.toContain('Social');
        expect(names).not.toContain('Casual');
        expect(names).toContain('Raider7');
    });

    it('returns empty array on error', async () => {
        mockGet.mockRejectedValue(new Error('API down'));
        const result = await getGuildRoster('eu', 'silvermoon', 'testguild');
        expect(result).toEqual([]);
    });
});

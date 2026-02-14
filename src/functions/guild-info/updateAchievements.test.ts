import { describe, it, expect, vi } from 'vitest';

// Mock dependencies that are loaded at module level
vi.mock('../../database/database.js', () => ({
    getDatabase: vi.fn(),
}));
vi.mock('../../utils.js', () => ({
    fetchTextChannel: vi.fn(),
    loadJson: () => ({
        title: 'Current Progress & Past Achievements',
        achievements: [
            { raid: 'Hellfire Citadel', progress: '13/13M', result: '**CE** WR 1170', expansion: 5 },
            { raid: 'Blackrock Foundry', progress: '8/10M', result: 'WR 1132', expansion: 5 },
            { raid: 'Highmaul', progress: '7/7M', result: '**CE** WR 1252', expansion: 5 },
            { raid: 'Siege of Orgrimmar (10 man)', progress: '14/14HC', result: '**CE** WR 1997', expansion: 4 },
        ],
    }),
}));
vi.mock('../../services/logger.js', () => ({
    logger: { debug: vi.fn().mockResolvedValue(undefined), warn: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../../services/raiderio.js', () => ({
    getRaidRankings: vi.fn(),
    getRaidStaticData: vi.fn(),
}));

import { checkIsCuttingEdge, buildManualAchievements } from './updateAchievements.js';

describe('checkIsCuttingEdge', () => {
    const makeRaid = (name: string, encounters: string[], endDate: string | null) => ({
        slug: name.toLowerCase(),
        name,
        encounters: encounters.map((s) => ({ slug: s, name: s })),
        ends: { eu: endDate, us: endDate },
    });

    const makeRanking = (defeated: Array<{ slug: string; firstDefeated: string }>) => ({
        encountersDefeated: defeated,
    });

    it('returns false for Fated raids', () => {
        const raid = makeRaid('Fated Nerub-ar Palace', ['boss1', 'boss2'], '2024-01-01');
        const ranking = makeRanking([
            { slug: 'boss1', firstDefeated: '2023-06-01' },
            { slug: 'boss2', firstDefeated: '2023-07-01' },
        ]);
        expect(checkIsCuttingEdge(raid, '2024-01-01', ranking, 2, 2)).toBe(false);
    });

    it('returns false when tier has not ended', () => {
        const futureDate = '2099-12-31';
        const raid = makeRaid('TestRaid', ['boss1'], futureDate);
        const ranking = makeRanking([{ slug: 'boss1', firstDefeated: '2025-01-01' }]);
        expect(checkIsCuttingEdge(raid, futureDate, ranking, 1, 1)).toBe(false);
    });

    it('returns false when not all bosses killed', () => {
        const raid = makeRaid('TestRaid', ['boss1', 'boss2'], '2024-01-01');
        const ranking = makeRanking([{ slug: 'boss1', firstDefeated: '2023-06-01' }]);
        expect(checkIsCuttingEdge(raid, '2024-01-01', ranking, 1, 2)).toBe(false);
    });

    it('returns false when last boss killed after tier end', () => {
        const raid = makeRaid('TestRaid', ['boss1', 'boss2'], '2024-01-01');
        const ranking = makeRanking([
            { slug: 'boss1', firstDefeated: '2023-06-01' },
            { slug: 'boss2', firstDefeated: '2024-06-01' }, // after tier end
        ]);
        expect(checkIsCuttingEdge(raid, '2024-01-01', ranking, 2, 2)).toBe(false);
    });

    it('returns true for valid CE', () => {
        const raid = makeRaid('TestRaid', ['boss1', 'boss2'], '2024-06-01');
        const ranking = makeRanking([
            { slug: 'boss1', firstDefeated: '2024-01-01' },
            { slug: 'boss2', firstDefeated: '2024-03-01' }, // before tier end
        ]);
        expect(checkIsCuttingEdge(raid, '2024-06-01', ranking, 2, 2)).toBe(true);
    });
});

describe('buildManualAchievements', () => {
    it('filters by expansion and formats columns', () => {
        const result = buildManualAchievements(5);
        expect(result.raids).toContain('Hellfire Citadel');
        expect(result.raids).toContain('Blackrock Foundry');
        expect(result.raids).toContain('Highmaul');
        expect(result.raids).not.toContain('Siege of Orgrimmar');

        expect(result.progress).toContain('13/13M');
        expect(result.progress).toContain('8/10M');
        expect(result.ranking).toContain('**CE** WR 1170');
    });

    it('returns empty strings for expansion with no data', () => {
        const result = buildManualAchievements(99);
        expect(result.raids).toBe('');
        expect(result.progress).toBe('');
        expect(result.ranking).toBe('');
    });
});

import { describe, it, expect, vi, afterEach } from 'vitest';
import { getProgressionContext } from '../../src/services/quipContext.js';
import * as raiderio from '../../src/services/raiderio.js';

vi.mock('../../src/services/raiderio.js');

const mockedStatic = vi.mocked(raiderio.getRaidStaticData);
const mockedRankings = vi.mocked(raiderio.getRaidRankings);

const ENCOUNTERS = [
  { id: 1, slug: 'boss-one', name: 'Boss One' },
  { id: 2, slug: 'boss-two', name: 'Boss Two' },
  { id: 3, slug: 'the-end-boss', name: 'The End Boss' },
];

function staticDataWithCurrentRaid() {
  return {
    raids: [
      {
        id: 1, slug: 'old-raid', name: 'Old Raid', expansion_id: 10,
        starts: { us: '2025-01-01', eu: '2025-01-01' },
        ends: { us: '2025-06-01', eu: '2025-06-01' },
        encounters: ENCOUNTERS,
      },
      {
        id: 2, slug: 'current-raid', name: 'Current Raid', expansion_id: 10,
        starts: { us: '2026-01-01', eu: '2026-01-01' },
        ends: { us: null, eu: null },
        encounters: ENCOUNTERS,
      },
    ],
  };
}

afterEach(() => {
  vi.resetAllMocks();
});

describe('getProgressionContext', () => {
  it('returns the current prog boss when not all bosses are dead', async () => {
    mockedStatic.mockResolvedValueOnce(staticDataWithCurrentRaid());
    mockedStatic.mockRejectedValueOnce(new Error('400 no such expansion'));
    mockedRankings.mockResolvedValueOnce([
      { rank: 123, guild: { name: 'seriouslycasual', realm: 'silvermoon', region: 'eu' }, encountersDefeated: 2, encountersTotal: 3 },
    ]);

    const ctx = await getProgressionContext();
    expect(ctx).toEqual({
      mode: 'progress',
      raidName: 'Current Raid',
      bossName: 'The End Boss',
      killed: 2,
      total: 3,
    });
  });

  it('returns reclear mode when the end boss is dead', async () => {
    mockedStatic.mockResolvedValueOnce(staticDataWithCurrentRaid());
    mockedStatic.mockRejectedValueOnce(new Error('400 no such expansion'));
    mockedRankings.mockResolvedValueOnce([
      { rank: 45, guild: { name: 'seriouslycasual', realm: 'silvermoon', region: 'eu' }, encountersDefeated: 3, encountersTotal: 3 },
    ]);

    const ctx = await getProgressionContext();
    expect(ctx).toEqual({
      mode: 'reclear',
      raidName: 'Current Raid',
      bossName: 'The End Boss',
      killed: 3,
      total: 3,
    });
  });

  it('returns null when rankings are empty (fresh tier)', async () => {
    mockedStatic.mockResolvedValueOnce(staticDataWithCurrentRaid());
    mockedStatic.mockRejectedValueOnce(new Error('400 no such expansion'));
    mockedRankings.mockResolvedValueOnce([]);

    expect(await getProgressionContext()).toBeNull();
  });

  it('returns null when the static-data API fails outright', async () => {
    mockedStatic.mockRejectedValue(new Error('raider.io down'));

    expect(await getProgressionContext()).toBeNull();
  });

  it('skips Fated/Awakened raids when finding the current raid', async () => {
    const data = staticDataWithCurrentRaid();
    data.raids.push({
      id: 3, slug: 'fated-current-raid', name: 'Fated Current Raid', expansion_id: 10,
      starts: { us: '2026-01-01', eu: '2026-01-01' },
      ends: { us: null, eu: null },
      encounters: ENCOUNTERS,
    });
    mockedStatic.mockResolvedValueOnce(data);
    mockedStatic.mockRejectedValueOnce(new Error('400 no such expansion'));
    mockedRankings.mockResolvedValueOnce([
      { rank: 1, guild: { name: 'seriouslycasual', realm: 'silvermoon', region: 'eu' }, encountersDefeated: 1, encountersTotal: 3 },
    ]);

    const ctx = await getProgressionContext();
    expect(ctx?.raidName).toBe('Current Raid');
  });
});

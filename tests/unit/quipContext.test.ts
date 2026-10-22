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
        id: 1,
        slug: 'old-raid',
        name: 'Old Raid',
        expansion_id: 10,
        starts: { us: '2025-01-01', eu: '2025-01-01' },
        ends: { us: '2025-06-01', eu: '2025-06-01' },
        encounters: ENCOUNTERS,
      },
      {
        id: 2,
        slug: 'current-raid',
        name: 'Current Raid',
        expansion_id: 10,
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
      {
        rank: 123,
        guild: { name: 'seriouslycasual', realm: 'silvermoon', region: 'eu' },
        encountersDefeated: 2,
        encountersTotal: 3,
      },
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
      {
        rank: 45,
        guild: { name: 'seriouslycasual', realm: 'silvermoon', region: 'eu' },
        encountersDefeated: 3,
        encountersTotal: 3,
      },
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
      id: 3,
      slug: 'fated-current-raid',
      name: 'Fated Current Raid',
      expansion_id: 10,
      starts: { us: '2026-01-01', eu: '2026-01-01' },
      ends: { us: null, eu: null },
      encounters: ENCOUNTERS,
    });
    mockedStatic.mockResolvedValueOnce(data);
    mockedStatic.mockRejectedValueOnce(new Error('400 no such expansion'));
    mockedRankings.mockResolvedValueOnce([
      {
        rank: 1,
        guild: { name: 'seriouslycasual', realm: 'silvermoon', region: 'eu' },
        encountersDefeated: 1,
        encountersTotal: 3,
      },
    ]);

    const ctx = await getProgressionContext();
    expect(ctx?.raidName).toBe('Current Raid');
  });

  it('picks the multi-boss main tier over concurrent one-boss side raids', async () => {
    const sentinel = { us: '2030-01-01T00:00:00Z', eu: '2030-01-01T00:00:00Z' };
    const sideRaid = (id: number, slug: string, name: string) => ({
      id,
      slug,
      name,
      expansion_id: 11,
      starts: { us: '2026-08-18T15:00:00Z', eu: '2026-08-19T04:00:00Z' },
      ends: sentinel,
      encounters: [{ id, slug: `${slug}-boss`, name: `${name} Boss` }],
    });

    mockedStatic.mockResolvedValueOnce({
      raids: [
        sideRaid(1, 'side-raid-a', 'Side Raid A'),
        {
          id: 2,
          slug: 'main-tier',
          name: 'Main Tier',
          expansion_id: 11,
          starts: { us: '2026-08-18T15:00:00Z', eu: '2026-08-19T04:00:00Z' },
          ends: sentinel,
          encounters: ENCOUNTERS,
        },
        sideRaid(3, 'side-raid-b', 'Side Raid B'),
      ],
    });
    mockedStatic.mockRejectedValueOnce(new Error('400 no such expansion'));
    mockedRankings.mockResolvedValueOnce([
      {
        rank: 1,
        guild: { name: 'seriouslycasual', realm: 'silvermoon', region: 'eu' },
        encountersDefeated: 1,
        encountersTotal: 3,
      },
    ]);

    const ctx = await getProgressionContext();
    expect(ctx?.raidName).toBe('Main Tier');
    expect(mockedRankings).toHaveBeenCalledWith('main-tier');
  });

  it('returns null when the API returns empty raids instead of erroring', async () => {
    mockedStatic.mockResolvedValue({ raids: [] });

    expect(await getProgressionContext()).toBeNull();
  });

  it('handles encountersDefeated returned as an array', async () => {
    mockedStatic.mockResolvedValueOnce(staticDataWithCurrentRaid());
    mockedStatic.mockRejectedValueOnce(new Error('400 no such expansion'));
    mockedRankings.mockResolvedValueOnce([
      {
        rank: 7,
        guild: { name: 'seriouslycasual', realm: 'silvermoon', region: 'eu' },
        encountersDefeated: [{}, {}] as unknown as number,
        encountersTotal: 3,
      },
    ]);

    const ctx = await getProgressionContext();
    expect(ctx?.mode).toBe('progress');
    expect(ctx?.killed).toBe(2);
    expect(ctx?.bossName).toBe('The End Boss');
  });

  it('gives up and returns null when the lookup exceeds the deadline', async () => {
    vi.useFakeTimers();
    try {
      mockedStatic.mockImplementation(() => new Promise(() => {}));

      const pending = getProgressionContext();
      await vi.advanceTimersByTimeAsync(10_001);
      expect(await pending).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

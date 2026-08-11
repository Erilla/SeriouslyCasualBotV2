import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, getDatabase } from '../../src/database/db.js';
import { createTables } from '../../src/database/schema.js';

const { mockedGetRaidStaticData } = vi.hoisted(() => ({
  mockedGetRaidStaticData: vi.fn(),
}));

vi.mock('../../src/services/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/services/raiderio.js', () => ({
  getRaidStaticData: mockedGetRaidStaticData,
}));

const { getRaidTierEnds } =
  await import('../../src/functions/applications/mythic-logs/raidTierEnds.js');

/** One expansion's worth of static data, trimmed to what the walk reads. */
const raid = (slug: string, endsEu: string | null) => ({
  id: 1,
  slug,
  name: slug,
  expansion_id: 9,
  starts: { us: null, eu: null },
  ends: { us: null, eu: endsEu },
  encounters: [],
});

beforeEach(() => {
  closeDatabase();
  createTables(getDatabase(':memory:'));
  mockedGetRaidStaticData.mockReset();
});

afterEach(() => {
  closeDatabase();
});

describe('getRaidTierEnds', () => {
  it("maps each raid slug to Raider.IO's EU end date", async () => {
    mockedGetRaidStaticData.mockImplementation(async (expansion: number) =>
      expansion === 9
        ? { raids: [raid('nerubar-palace', '2025-03-04T00:00:00.000Z')] }
        : { raids: [] },
    );

    const ends = await getRaidTierEnds();

    expect(ends.get('nerubar-palace')).toBe('2025-03-04T00:00:00.000Z');
  });

  it('keeps an open-ended tier as null rather than omitting it', async () => {
    mockedGetRaidStaticData.mockImplementation(async (expansion: number) =>
      expansion === 9 ? { raids: [raid('manaforge-omega', null)] } : { raids: [] },
    );

    const ends = await getRaidTierEnds();

    expect(ends.has('manaforge-omega')).toBe(true);
    expect(ends.get('manaforge-omega')).toBeNull();
  });

  it('lets an officer CE override win over the published end date', async () => {
    // The same precedence the guild achievements panel uses, so one rule decides
    // what CE means in both places.
    mockedGetRaidStaticData.mockImplementation(async (expansion: number) =>
      expansion === 9
        ? { raids: [raid('nerubar-palace', '2025-03-04T00:00:00.000Z')] }
        : { raids: [] },
    );
    getDatabase()
      .prepare('INSERT INTO achievement_ce_overrides (raid_slug, cutoff_at) VALUES (?, ?)')
      .run('nerubar-palace', '2025-02-01T00:00:00.000Z');

    const ends = await getRaidTierEnds();

    expect(ends.get('nerubar-palace')).toBe('2025-02-01T00:00:00.000Z');
  });

  it('walks past the first expansion and stops at the first empty one', async () => {
    mockedGetRaidStaticData.mockImplementation(async (expansion: number) => {
      if (expansion === 9) return { raids: [raid('nerubar-palace', null)] };
      if (expansion === 10) return { raids: [raid('manaforge-omega', null)] };
      return { raids: [] };
    });

    const ends = await getRaidTierEnds();

    expect([...ends.keys()]).toEqual(['nerubar-palace', 'manaforge-omega']);
    // Stopped rather than climbing to the cap.
    expect(mockedGetRaidStaticData).toHaveBeenCalledTimes(3);
  });

  it('returns what it gathered when an expansion lookup throws', async () => {
    // Guild history must still publish if Raider.IO is unavailable.
    mockedGetRaidStaticData.mockImplementation(async (expansion: number) => {
      if (expansion === 9) return { raids: [raid('nerubar-palace', null)] };
      throw new Error('raider.io down');
    });

    const ends = await getRaidTierEnds();

    expect([...ends.keys()]).toEqual(['nerubar-palace']);
  });

  it('gives an empty map, not a rejection, when the very first lookup fails', async () => {
    mockedGetRaidStaticData.mockRejectedValue(new Error('raider.io down'));

    await expect(getRaidTierEnds()).resolves.toEqual(new Map());
  });
});

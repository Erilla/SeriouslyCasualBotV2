import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockedGetRaidStaticData, postedBosses } = vi.hoisted(() => ({
  mockedGetRaidStaticData: vi.fn(),
  postedBosses: [] as Array<{ id: number; name: string }>,
}));

vi.mock('../../src/config.js', () => ({ config: { guildId: 'guild-id' } }));
vi.mock('../../src/services/logger.js', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock('../../src/services/raiderio.js', () => ({ getRaidStaticData: mockedGetRaidStaticData }));
vi.mock('../../src/functions/channels.js', () => ({
  getOrCreateChannel: vi.fn(async () => ({ id: 'loot-channel' })),
}));
vi.mock('../../src/functions/loot/addLootPost.js', () => ({
  addLootPost: vi.fn(async (_channel, boss: { id: number; name: string }) => {
    postedBosses.push(boss);
  }),
}));

const { checkRaidExpansions } = await import('../../src/functions/loot/checkRaidExpansions.js');

afterEach(() => {
  mockedGetRaidStaticData.mockReset();
  postedBosses.splice(0);
});

describe('checkRaidExpansions', () => {
  it('creates posts for every raid that remains current in the newest expansion', async () => {
    mockedGetRaidStaticData.mockImplementation(async (expansion: number) => {
      if (expansion !== 9) throw new Error('unknown expansion');
      return {
        raids: [
          {
            id: 1,
            slug: 'expired-raid',
            name: 'Expired Raid',
            expansion_id: 9,
            starts: { us: '2025-01-01T00:00:00.000Z', eu: '2025-01-01T00:00:00.000Z' },
            ends: { us: '2025-06-01T00:00:00.000Z', eu: '2025-06-01T00:00:00.000Z' },
            encounters: [{ id: 10, slug: 'expired-boss', name: 'Expired Boss' }],
          },
          {
            id: 2,
            slug: 'main-raid',
            name: 'Main Raid',
            expansion_id: 9,
            starts: { us: '2026-01-01T00:00:00.000Z', eu: '2026-01-01T00:00:00.000Z' },
            ends: { us: null, eu: null },
            encounters: [{ id: 20, slug: 'main-boss', name: 'Main Boss' }],
          },
          {
            id: 3,
            slug: 'one-boss-raid',
            name: 'One Boss Raid',
            expansion_id: 9,
            starts: { us: '2026-01-01T00:00:00.000Z', eu: '2026-01-01T00:00:00.000Z' },
            ends: { us: null, eu: null },
            encounters: [{ id: 30, slug: 'one-boss', name: 'One Boss' }],
          },
        ],
      };
    });

    await checkRaidExpansions({ guilds: { fetch: vi.fn(async () => ({})) } } as never);

    expect(postedBosses).toEqual([
      { id: 20, name: 'Main Boss' },
      { id: 30, name: 'One Boss' },
    ]);
  });
});

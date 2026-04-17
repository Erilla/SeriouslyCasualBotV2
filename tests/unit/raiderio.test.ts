import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock config before importing the module under test
vi.mock('../../src/config.js', () => ({
  config: {
    raiderIoGuildIds: 'test-guild-id',
  },
}));

import { getGuildRoster, getRaidRankings, getRaidStaticData, getWeeklyMythicPlusRuns } from '../../src/services/raiderio.js';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('getGuildRoster', () => {
  it('should return only members with allowed ranks [0,1,3,4,5,7]', async () => {
    const mockMembers = [
      { rank: 0, character: { name: 'GuildMaster', realm: 'silvermoon', region: 'eu', class: 'Warrior' } },
      { rank: 1, character: { name: 'Officer1', realm: 'silvermoon', region: 'eu', class: 'Mage' } },
      { rank: 2, character: { name: 'ShouldBeExcluded', realm: 'silvermoon', region: 'eu', class: 'Rogue' } },
      { rank: 3, character: { name: 'Raider1', realm: 'silvermoon', region: 'eu', class: 'Paladin' } },
      { rank: 4, character: { name: 'Raider2', realm: 'silvermoon', region: 'eu', class: 'Priest' } },
      { rank: 5, character: { name: 'Trial1', realm: 'silvermoon', region: 'eu', class: 'Druid' } },
      { rank: 6, character: { name: 'AlsoExcluded', realm: 'silvermoon', region: 'eu', class: 'Hunter' } },
      { rank: 7, character: { name: 'Social1', realm: 'silvermoon', region: 'eu', class: 'Warlock' } },
      { rank: 8, character: { name: 'ExcludedToo', realm: 'silvermoon', region: 'eu', class: 'Monk' } },
    ];

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ members: mockMembers }),
    });

    const result = await getGuildRoster();

    expect(result).toHaveLength(6);
    const names = result.map((m) => m.character.name);
    expect(names).toContain('GuildMaster');
    expect(names).toContain('Officer1');
    expect(names).toContain('Raider1');
    expect(names).toContain('Raider2');
    expect(names).toContain('Trial1');
    expect(names).toContain('Social1');
    expect(names).not.toContain('ShouldBeExcluded');
    expect(names).not.toContain('AlsoExcluded');
    expect(names).not.toContain('ExcludedToo');
  });

  it('should throw on non-OK response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });

    await expect(getGuildRoster()).rejects.toThrow('Raider.io API error: 500 Internal Server Error');
  });

  it('should call the correct URL', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ members: [] }),
    });

    await getGuildRoster();

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://raider.io/api/v1/guilds/profile?region=eu&realm=silvermoon&name=seriouslycasual&fields=members',
    );
  });
});

describe('getRaidRankings', () => {
  it('should fetch rankings for a given raid slug', async () => {
    const mockRankings = [
      { rank: 1, guild: { name: 'Test', realm: 'silvermoon', region: 'eu' }, encountersDefeated: 8, encountersTotal: 8 },
    ];

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ raidRankings: mockRankings }),
    });

    const result = await getRaidRankings('nerubar-palace');

    expect(result).toEqual(mockRankings);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('raid=nerubar-palace'),
    );
  });

  it('should throw on non-OK response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });

    await expect(getRaidRankings('invalid')).rejects.toThrow('Raider.io API error: 404 Not Found');
  });
});

describe('getRaidStaticData', () => {
  it('should fetch static data for an expansion', async () => {
    const mockData = {
      raids: [{ id: 1, slug: 'test-raid', name: 'Test Raid', expansion_id: 10, encounters: [] }],
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockData,
    });

    const result = await getRaidStaticData(10);

    expect(result).toEqual(mockData);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('expansion_id=10'),
    );
  });
});

describe('getWeeklyMythicPlusRuns', () => {
  it('should fetch M+ runs for a character', async () => {
    const mockRuns = [
      { dungeon: 'The Stonevault', short_name: 'SV', mythic_level: 12, num_keystone_upgrades: 2, score: 150 },
    ];

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ mythic_plus_previous_weekly_highest_level_runs: mockRuns }),
    });

    const result = await getWeeklyMythicPlusRuns('eu', 'silvermoon', 'Testchar');

    expect(result).toEqual(mockRuns);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('name=Testchar'),
    );
  });

  it('should encode character names with special characters', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ mythic_plus_previous_weekly_highest_level_runs: [] }),
    });

    await getWeeklyMythicPlusRuns('eu', 'silvermoon', 'Tëst Chàr');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining(`name=${encodeURIComponent('Tëst Chàr')}`),
    );
  });
});

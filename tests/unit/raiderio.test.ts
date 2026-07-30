import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock config before importing the module under test
vi.mock('../../src/config.js', () => ({
  config: {
    raiderIoGuildIds: 'test-guild-id',
  },
}));

import {
  getGuildRaidEncounters,
  getGuildRaidSummary,
  getGuildRoster,
  getLiveRaidProgress,
  getRaidRankings,
  getRaidStaticData,
  getPreviousWeekProfile,
  getWeeklyMythicPlusRuns,
} from '../../src/services/raiderio.js';
import { __resetForTests } from '../../src/services/apiHealth.js';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.restoreAllMocks();
  __resetForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('getGuildRoster', () => {
  it('should return only members with allowed ranks [0,1,3,4,5,7]', async () => {
    const mockMembers = [
      {
        rank: 0,
        character: { name: 'GuildMaster', realm: 'silvermoon', region: 'eu', class: 'Warrior' },
      },
      {
        rank: 1,
        character: { name: 'Officer1', realm: 'silvermoon', region: 'eu', class: 'Mage' },
      },
      {
        rank: 2,
        character: { name: 'ShouldBeExcluded', realm: 'silvermoon', region: 'eu', class: 'Rogue' },
      },
      {
        rank: 3,
        character: { name: 'Raider1', realm: 'silvermoon', region: 'eu', class: 'Paladin' },
      },
      {
        rank: 4,
        character: { name: 'Raider2', realm: 'silvermoon', region: 'eu', class: 'Priest' },
      },
      { rank: 5, character: { name: 'Trial1', realm: 'silvermoon', region: 'eu', class: 'Druid' } },
      {
        rank: 6,
        character: { name: 'AlsoExcluded', realm: 'silvermoon', region: 'eu', class: 'Hunter' },
      },
      {
        rank: 7,
        character: { name: 'Social1', realm: 'silvermoon', region: 'eu', class: 'Warlock' },
      },
      {
        rank: 8,
        character: { name: 'ExcludedToo', realm: 'silvermoon', region: 'eu', class: 'Monk' },
      },
    ];

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
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

  it('retries on 5xx and throws HttpError after exhausting retries', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      headers: new Headers(),
    });
    globalThis.fetch = fetchMock;

    const promise = getGuildRoster().catch((e) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    const err = await promise;

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('raiderio');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it('should call the correct URL', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: async () => ({ members: [] }),
    });

    await getGuildRoster();

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://raider.io/api/v1/guilds/profile?region=eu&realm=silvermoon&name=seriouslycasual&fields=members',
      expect.any(Object),
    );
  });
});

describe('getRaidRankings', () => {
  it('should fetch rankings for a given raid slug', async () => {
    const mockRankings = [
      {
        rank: 1,
        guild: { name: 'Test', realm: 'silvermoon', region: 'eu' },
        encountersDefeated: 8,
        encountersTotal: 8,
      },
    ];

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: async () => ({ raidRankings: mockRankings }),
    });

    const result = await getRaidRankings('nerubar-palace');

    expect(result).toEqual(mockRankings);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('raid=nerubar-palace'),
      expect.any(Object),
    );
  });

  it('throws HttpError without retry on 404', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      headers: new Headers(),
    });
    globalThis.fetch = fetchMock;

    await expect(getRaidRankings('invalid')).rejects.toThrow('raiderio');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('getRaidStaticData', () => {
  it('should fetch static data for an expansion', async () => {
    const mockData = {
      raids: [{ id: 1, slug: 'test-raid', name: 'Test Raid', expansion_id: 10, encounters: [] }],
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: async () => mockData,
    });

    const result = await getRaidStaticData(10);

    expect(result).toEqual(mockData);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('expansion_id=10'),
      expect.any(Object),
    );
  });
});

describe('getPreviousWeekProfile', () => {
  it('returns M+ runs and when the profile was last crawled', async () => {
    const mockRuns = [
      {
        dungeon: 'The Stonevault',
        short_name: 'SV',
        mythic_level: 12,
        num_keystone_upgrades: 2,
        score: 150,
      },
    ];

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: async () => ({
        mythic_plus_previous_weekly_highest_level_runs: mockRuns,
        last_crawled_at: '2026-07-29T10:00:00Z',
      }),
    });

    const result = await getPreviousWeekProfile('eu', 'silvermoon', 'Testchar');

    expect(result).toEqual({
      runs: mockRuns,
      lastCrawledAt: '2026-07-29T10:00:00Z',
    });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('name=Testchar'),
      expect.any(Object),
    );
  });

  it('should encode character names with special characters', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: async () => ({ mythic_plus_previous_weekly_highest_level_runs: [] }),
    });

    await getWeeklyMythicPlusRuns('eu', 'silvermoon', 'Tëst Chàr');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining(`name=${encodeURIComponent('Tëst Chàr')}`),
      expect.any(Object),
    );
  });
});

const identity = { region: 'eu', realm: 'silvermoon', name: 'seriouslycasual' };

describe('getGuildRaidSummary', () => {
  it('requests parameterised raid_progression and raid_rankings fields', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: async () => ({ raid_progression: {}, raid_rankings: {} }),
    });

    await getGuildRaidSummary(identity, [6, 7, 10]);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://raider.io/api/v1/guilds/profile?region=eu&realm=silvermoon&name=seriouslycasual' +
        '&fields=raid_progression%3A6%3A7%3A10%2Craid_rankings%3A6%3A7%3A10',
      expect.any(Object),
    );
  });

  it('defaults missing sections to empty objects', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: async () => ({ name: 'SeriouslyCasual' }),
    });

    const result = await getGuildRaidSummary(identity, [10]);
    expect(result).toEqual({ raid_progression: {}, raid_rankings: {} });
  });

  it('URL-encodes identities with spaces', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: async () => ({ raid_progression: {}, raid_rankings: {} }),
    });

    await getGuildRaidSummary({ region: 'eu', realm: 'darksorrow', name: 'seriously casual' }, [6]);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('name=seriously%20casual'),
      expect.any(Object),
    );
  });
});

describe('getGuildRaidEncounters', () => {
  it('requests the raid_encounters field for the raid at mythic', async () => {
    const kills = [
      { slug: 'queen-ansurek', name: 'Queen Ansurek', defeatedAt: '2025-02-12T20:37:04.000Z' },
    ];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: async () => ({ raid_encounters: kills }),
    });

    const result = await getGuildRaidEncounters(identity, 'nerubar-palace');

    expect(result).toEqual(kills);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('fields=raid_encounters%3Anerubar-palace%3Amythic'),
      expect.any(Object),
    );
  });

  it('returns [] when the field is absent', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: async () => ({}),
    });
    expect(await getGuildRaidEncounters(identity, 'nerubar-palace')).toEqual([]);
  });
});

describe('getLiveRaidProgress', () => {
  it('requests live raid progress with period=until_kill and returns bosses', async () => {
    const bosses = [
      {
        boss: {
          name: 'Midnight Falls',
          slug: 'midnight-falls',
          ordinal: 8,
          iconUrl: '/images/wow/icons/large/foo.jpg',
        },
        pullCount: 199,
        bestPercent: 67.24,
        isDefeated: false,
      },
    ];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: async () => ({ bosses }),
    });

    const result = await getLiveRaidProgress(identity, 'tier-mn-1');

    expect(result).toEqual(bosses);
    const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain('/live-tracking/guild/raid-progress?');
    expect(url).toContain('raid=tier-mn-1');
    expect(url).toContain('difficulty=mythic');
    expect(url).toContain('period=until_kill');
    expect(url).toContain('guild=seriouslycasual');
  });

  it('returns [] when the response has no bosses', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: async () => ({}),
    });
    expect(await getLiveRaidProgress(identity, 'tier-mn-1')).toEqual([]);
  });
});

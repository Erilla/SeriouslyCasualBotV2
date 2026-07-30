import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, initDatabase } from '../../src/database/db.js';
import {
  buildAchievementsModel,
  mergeGuildSummaries,
  determineCE,
  staticDataFreshness,
  expansionIconName,
  zamimgUrl,
  iconNameFromUrl,
  raidIconName,
} from '../../src/functions/guild-info/achievementsData.js';
import type { RaidStaticData } from '../../src/services/raiderio.js';
import { HttpError } from '../../src/services/httpClient.js';
import { setCeOverride } from '../../src/functions/guild-info/ceOverrides.js';

const originalFetch = globalThis.fetch;

vi.mock('../../src/services/raiderio.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/raiderio.js')>();
  return {
    ...actual,
    getRaidStaticData: vi.fn(),
    getGuildRaidSummary: vi.fn(),
    getGuildRaidEncounters: vi.fn(),
    getLiveRaidProgress: vi.fn(),
  };
});

vi.mock('../../src/config.js', () => ({
  config: {
    raiderIoGuilds: [
      { region: 'eu', realm: 'silvermoon', name: 'seriouslycasual' },
      { region: 'eu', realm: 'darksorrow', name: 'seriously casual' },
    ],
    raiderIoGuildIds: 'test',
  },
}));

import {
  getGuildRaidEncounters,
  getGuildRaidSummary,
  getLiveRaidProgress,
  getRaidStaticData,
} from '../../src/services/raiderio.js';

const silvermoon = { region: 'eu', realm: 'silvermoon', name: 'seriouslycasual' };
const darksorrow = { region: 'eu', realm: 'darksorrow', name: 'seriously casual' };

function summaryFor(raids: Record<string, { killed: number; total: number; world: number }>) {
  const raid_progression: Record<
    string,
    { summary: string; total_bosses: number; mythic_bosses_killed: number }
  > = {};
  const raid_rankings: Record<
    string,
    { mythic: { world: number; region: number; realm: number } }
  > = {};
  for (const [slug, r] of Object.entries(raids)) {
    raid_progression[slug] = {
      summary: `${r.killed}/${r.total} M`,
      total_bosses: r.total,
      mythic_bosses_killed: r.killed,
    };
    raid_rankings[slug] = { mythic: { world: r.world, region: 0, realm: 0 } };
  }
  return { raid_progression, raid_rankings };
}

describe('mergeGuildSummaries', () => {
  it('takes the identity with more mythic kills per raid', () => {
    const merged = mergeGuildSummaries([
      {
        identity: silvermoon,
        summary: summaryFor({ 'raid-a': { killed: 3, total: 8, world: 900 } }),
      },
      {
        identity: darksorrow,
        summary: summaryFor({ 'raid-a': { killed: 8, total: 8, world: 1200 } }),
      },
    ]);
    expect(merged.get('raid-a')).toEqual({
      identity: darksorrow,
      mythicKilled: 8,
      totalBosses: 8,
      worldRank: 1200,
    });
  });

  it('breaks kill ties on better non-zero world rank', () => {
    const merged = mergeGuildSummaries([
      {
        identity: silvermoon,
        summary: summaryFor({ 'raid-a': { killed: 8, total: 8, world: 0 } }),
      },
      {
        identity: darksorrow,
        summary: summaryFor({ 'raid-a': { killed: 8, total: 8, world: 1200 } }),
      },
    ]);
    expect(merged.get('raid-a')!.identity).toEqual(darksorrow);
    expect(merged.get('raid-a')!.worldRank).toBe(1200);
  });

  it('unions raids that exist under only one identity', () => {
    const merged = mergeGuildSummaries([
      {
        identity: silvermoon,
        summary: summaryFor({ 'raid-new': { killed: 5, total: 8, world: 2000 } }),
      },
      {
        identity: darksorrow,
        summary: summaryFor({ 'raid-old': { killed: 7, total: 7, world: 800 } }),
      },
    ]);
    expect(merged.get('raid-new')!.identity).toEqual(silvermoon);
    expect(merged.get('raid-old')!.identity).toEqual(darksorrow);
  });
});

describe('determineCE', () => {
  it('is false when not all bosses are killed', () => {
    expect(
      determineCE({ mythicKilled: 7, totalBosses: 8, tierEndsEu: null, lastBossDefeatedAt: null }),
    ).toBe(false);
  });

  it('is true for a full clear in an ongoing tier (end date in the future)', () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect(
      determineCE({
        mythicKilled: 8,
        totalBosses: 8,
        tierEndsEu: future,
        lastBossDefeatedAt: null,
      }),
    ).toBe(true);
  });

  it('is true when the last boss died before the tier ended', () => {
    expect(
      determineCE({
        mythicKilled: 8,
        totalBosses: 8,
        tierEndsEu: '2025-03-05T04:00:00Z',
        lastBossDefeatedAt: '2025-02-12T20:37:04Z',
      }),
    ).toBe(true);
  });

  it('is false when the last boss died after the tier ended', () => {
    expect(
      determineCE({
        mythicKilled: 8,
        totalBosses: 8,
        tierEndsEu: '2025-03-05T04:00:00Z',
        lastBossDefeatedAt: '2025-04-01T20:00:00Z',
      }),
    ).toBe(false);
  });

  it('assumes CE when the kill timestamp is unavailable (matches current behaviour)', () => {
    expect(
      determineCE({
        mythicKilled: 8,
        totalBosses: 8,
        tierEndsEu: '2025-03-05T04:00:00Z',
        lastBossDefeatedAt: null,
      }),
    ).toBe(true);
  });
});

describe('staticDataFreshness', () => {
  const past = '2020-01-01T00:00:00Z';
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const raid = (endsEu: string | null) => ({
    id: 1,
    slug: 's',
    name: 'n',
    expansion_id: 6,
    starts: { us: null, eu: null },
    ends: { us: null, eu: endsEu },
    encounters: [],
  });

  it('never treats an empty expansion as fresh', () => {
    expect(staticDataFreshness({ raids: [] } as RaidStaticData, new Date())).toBe(false);
  });

  it('treats a fully-ended expansion as fresh forever', () => {
    const old = new Date('2020-06-01T00:00:00Z');
    expect(staticDataFreshness({ raids: [raid(past)] } as RaidStaticData, old)).toBe(true);
  });

  it('treats an open expansion as fresh only within 7 days', () => {
    const data = { raids: [raid(future)] } as RaidStaticData;
    expect(staticDataFreshness(data, new Date())).toBe(true);
    expect(staticDataFreshness(data, new Date(Date.now() - 8 * 86_400_000))).toBe(false);
  });
});

describe('icon helpers', () => {
  it('maps known expansions and falls back to the newest raid icon', () => {
    expect(expansionIconName(4, null)).toBe('expansionicon_mistsofpandaria');
    expect(expansionIconName(8, 'ignored')).toBe('inv_progenitor_runevessel');
    expect(expansionIconName(10, 'inv_112_achievement_raid_manaforgeomega')).toBe(
      'inv_112_achievement_raid_manaforgeomega',
    );
    expect(expansionIconName(10, null)).toBeNull();
  });

  it('builds zamimg URLs and extracts names from raider.io iconUrl paths', () => {
    expect(zamimgUrl('achievement_boss_garrosh')).toBe(
      'https://wow.zamimg.com/images/wow/icons/large/achievement_boss_garrosh.jpg',
    );
    expect(iconNameFromUrl('/images/wow/icons/large/inv_120_raid_voidspire_kaiju.jpg')).toBe(
      'inv_120_raid_voidspire_kaiju',
    );
    expect(iconNameFromUrl('')).toBeNull();
  });

  it('uses Legion fallback icons only when Raider.IO omits a raid icon', () => {
    expect(raidIconName({ slug: 'the-emerald-nightmare', icon: null })).toBe(
      'achievement_emeraldnightmare_xavius',
    );
    expect(raidIconName({ slug: 'the-nighthold', icon: null })).toBe('achievement_thenighthold');
    expect(raidIconName({ slug: 'trial-of-valor', icon: null })).toBe(
      'achievement_raid_trialofvalor',
    );
    expect(raidIconName({ slug: 'tomb-of-sargeras', icon: null })).toBe(
      'achievement_boss_kiljaeden2',
    );
    expect(raidIconName({ slug: 'antorus-the-burning-throne', icon: null })).toBe(
      'achievement_boss_argus_worldsoul',
    );
    expect(raidIconName({ slug: 'the-nighthold', icon: 'raider-icon' })).toBe('raider-icon');
  });
});

describe('buildAchievementsModel', () => {
  const PAST = '2020-06-01T00:00:00Z';
  const FUTURE = new Date(Date.now() + 30 * 86_400_000).toISOString();

  const legionStatic = {
    raids: [
      {
        id: 1,
        slug: 'the-emerald-nightmare',
        name: 'The Emerald Nightmare',
        expansion_id: 6,
        icon: 'achievement_zone_emeraldnightmare',
        starts: { us: PAST, eu: PAST },
        ends: { us: PAST, eu: PAST },
        encounters: [
          { id: 1, slug: 'nythendra', name: 'Nythendra' },
          { id: 2, slug: 'xavius', name: 'Xavius' },
        ],
      },
      {
        id: 2,
        slug: 'fated-the-emerald-nightmare',
        name: 'Fated The Emerald Nightmare',
        expansion_id: 6,
        icon: 'achievement_zone_emeraldnightmare',
        starts: { us: PAST, eu: PAST },
        ends: { us: PAST, eu: PAST },
        encounters: [{ id: 1, slug: 'nythendra', name: 'Nythendra' }],
      },
    ],
  };
  const midnightStatic = {
    raids: [
      {
        id: 3,
        slug: 'tier-mn-1',
        name: 'MN Tier 1 (VS / DR / MQD)',
        expansion_id: 7,
        icon: 'inv_achievement_raid_darkwell',
        starts: { us: PAST, eu: PAST },
        ends: { us: FUTURE, eu: FUTURE },
        encounters: [
          { id: 10, slug: 'imperator-averzian', name: 'Imperator Averzian' },
          { id: 11, slug: 'midnight-falls', name: 'Midnight Falls' },
        ],
      },
    ],
  };

  beforeEach(() => {
    initDatabase(':memory:');
    vi.mocked(getRaidStaticData).mockReset();
    vi.mocked(getGuildRaidSummary).mockReset();
    vi.mocked(getGuildRaidEncounters).mockReset();
    vi.mocked(getLiveRaidProgress).mockReset();

    vi.mocked(getRaidStaticData).mockImplementation(async (exp: number) => {
      if (exp === 6) return legionStatic as never;
      if (exp === 7) return midnightStatic as never;
      return { raids: [] } as never;
    });

    vi.mocked(getGuildRaidSummary).mockImplementation(async (identity) => {
      if (identity.realm === 'darksorrow') {
        return {
          raid_progression: {
            'the-emerald-nightmare': {
              summary: '2/2 M',
              total_bosses: 2,
              mythic_bosses_killed: 2,
            },
          },
          raid_rankings: {
            'the-emerald-nightmare': { mythic: { world: 818, region: 520, realm: 17 } },
          },
        };
      }
      return {
        raid_progression: {
          'tier-mn-1': { summary: '1/2 M', total_bosses: 2, mythic_bosses_killed: 1 },
          'fated-the-emerald-nightmare': {
            summary: '1/1 M',
            total_bosses: 1,
            mythic_bosses_killed: 1,
          },
        },
        raid_rankings: {
          'tier-mn-1': { mythic: { world: 2281, region: 1106, realm: 52 } },
          'fated-the-emerald-nightmare': { mythic: { world: 805, region: 485, realm: 15 } },
        },
      };
    });

    vi.mocked(getGuildRaidEncounters).mockResolvedValue([
      { slug: 'nythendra', name: 'Nythendra', defeatedAt: '2016-10-01T00:00:00Z' },
      { slug: 'xavius', name: 'Xavius', defeatedAt: '2016-11-01T00:00:00Z' },
    ]);

    vi.mocked(getLiveRaidProgress).mockResolvedValue([
      {
        boss: {
          name: 'Midnight Falls',
          slug: 'midnight-falls',
          ordinal: 1,
          iconUrl: '/images/wow/icons/large/boss_b.jpg',
        },
        pullCount: 199,
        bestPercent: 67.24,
        isDefeated: false,
      },
      {
        boss: {
          name: 'Imperator Averzian',
          slug: 'imperator-averzian',
          ordinal: 0,
          iconUrl: '/images/wow/icons/large/boss_a.jpg',
        },
        pullCount: 7,
        bestPercent: 0,
        isDefeated: 1,
      },
    ]);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([0xff, 0xd8]).buffer,
    });
  });

  afterEach(() => {
    closeDatabase();
    globalThis.fetch = originalFetch;
  });

  it('builds API sections newest-expansion-first, filtering Fated raids and zero-kill raids', async () => {
    const model = await buildAchievementsModel();
    const labels = model.sections.map((s) => s.expansionLabel);
    expect(labels).toEqual([
      'Battle for Azeroth',
      'Legion',
      'Warlords of Draenor',
      'Mists of Pandaria',
    ]);
    const legion = model.sections[1]!;
    expect(legion.rows.map((r) => r.raid)).toEqual(['The Emerald Nightmare']);
  });

  it('marks CE and formats progress/result on merged rows', async () => {
    const model = await buildAchievementsModel();
    const en = model.sections[1]!.rows[0]!;
    expect(en.progress).toBe('2/2M');
    expect(en.isCE).toBe(true);
    expect(en.result).toBe('WR 818');
    expect(en.icon).toBe('achievement_zone_emeraldnightmare');
  });

  it('uses a saved cutoff instead of Raider.IO’s later raid end date for CE', async () => {
    vi.mocked(getRaidStaticData).mockImplementation(async (exp: number) => {
      if (exp !== 6) return { raids: [] } as never;
      return {
        raids: [
          {
            id: 9,
            slug: 'manaforge-omega',
            name: 'Manaforge Omega',
            expansion_id: 6,
            icon: null,
            starts: { us: '2025-08-12T04:00:00Z', eu: '2025-08-13T04:00:00Z' },
            ends: { us: '2026-03-02T22:00:00Z', eu: '2026-03-02T22:00:00Z' },
            encounters: [
              { id: 90, slug: 'earlier-boss', name: 'Earlier Boss' },
              { id: 91, slug: 'dimensius', name: 'Dimensius' },
            ],
          },
        ],
      } as never;
    });
    vi.mocked(getGuildRaidSummary).mockResolvedValue(
      summaryFor({ 'manaforge-omega': { killed: 2, total: 2, world: 100 } }) as never,
    );
    vi.mocked(getGuildRaidEncounters).mockResolvedValue([
      { slug: 'dimensius', name: 'Dimensius', defeatedAt: '2026-01-28T21:53:45.496Z' },
    ]);
    setCeOverride('manaforge-omega', '2026-01-21T00:00:00.000Z');

    const model = await buildAchievementsModel();

    expect(model.sections[0]!.rows[0]!.isCE).toBe(false);
  });

  it('attaches an ordinal-sorted live breakdown to in-progress current-expansion raids', async () => {
    const model = await buildAchievementsModel();
    const current = model.sections[0]!.rows[0]!;
    expect(current.raid).toBe('MN Tier 1 (VS / DR / MQD)');
    expect(current.bosses).toHaveLength(2);
    expect(current.bosses![0]).toEqual({
      name: 'Imperator Averzian',
      icon: 'boss_a',
      pulls: 7,
      bestPercent: 0,
      defeated: true,
    });
    expect(current.bosses![1]).toEqual({
      name: 'Midnight Falls',
      icon: 'boss_b',
      pulls: 199,
      bestPercent: 67.24,
      defeated: false,
    });
    expect(vi.mocked(getLiveRaidProgress)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getLiveRaidProgress)).toHaveBeenCalledWith(
      expect.objectContaining({ realm: 'silvermoon' }),
      'tier-mn-1',
    );
  });

  it('includes manual sections with icons and resolves every referenced icon', async () => {
    const model = await buildAchievementsModel();
    const wod = model.sections.find((s) => s.expansionLabel === 'Warlords of Draenor')!;
    expect(wod.rows.map((r) => r.raid)).toEqual([
      'Hellfire Citadel',
      'Blackrock Foundry',
      'Highmaul',
    ]);
    const hfc = wod.rows[0]!;
    expect(hfc.icon).toBe('achievement_boss_hellfire_archimonde');
    expect(hfc.isCE).toBe(true);
    expect(hfc.result).toBe('WR 1170');

    for (const section of model.sections) {
      if (section.expansionIcon) expect(model.icons.has(section.expansionIcon)).toBe(true);
      for (const row of section.rows) {
        if (row.icon) expect(model.icons.has(row.icon)).toBe(true);
        for (const boss of row.bosses ?? []) {
          if (boss.icon) expect(model.icons.has(boss.icon)).toBe(true);
        }
      }
    }
  });

  it('propagates API errors (fail-fast, no partial model)', async () => {
    vi.mocked(getGuildRaidSummary).mockRejectedValue(new Error('rio down'));
    await expect(buildAchievementsModel()).rejects.toThrow('rio down');
  });

  it('stops the static-data scan when Raider.IO rejects the next expansion id', async () => {
    vi.mocked(getRaidStaticData).mockImplementation(async (exp: number) => {
      if (exp === 6) return legionStatic as never;
      if (exp === 7) return midnightStatic as never;
      throw Object.assign(
        new HttpError({
          service: 'raiderio',
          status: 400,
          attempts: 1,
          message: 'raiderio API error: 400 Bad Request',
        }),
        { responseMessage: 'Requested unsupported expansion_id' },
      );
    });

    await expect(buildAchievementsModel()).resolves.toEqual(
      expect.objectContaining({ sections: expect.any(Array) }),
    );
    expect(vi.mocked(getRaidStaticData)).toHaveBeenLastCalledWith(8);
  });

  it('propagates a non-terminal 400 mid-scan instead of posting incomplete data', async () => {
    vi.mocked(getRaidStaticData).mockImplementation(async (exp: number) => {
      if (exp === 6) return legionStatic as never;
      if (exp === 7) return midnightStatic as never;
      throw Object.assign(
        new HttpError({
          service: 'raiderio',
          status: 400,
          attempts: 1,
          message: 'raiderio API error: 400 Bad Request',
        }),
        { responseMessage: 'expansion_id must be one of 1..11' },
      );
    });

    await expect(buildAchievementsModel()).rejects.toThrow('raiderio API error: 400 Bad Request');
  });

  it('propagates a 400 on the first expansion id, which means a malformed request', async () => {
    vi.mocked(getRaidStaticData).mockRejectedValue(
      Object.assign(
        new HttpError({
          service: 'raiderio',
          status: 400,
          attempts: 1,
          message: 'raiderio API error: 400 Bad Request',
        }),
        { responseMessage: 'Invalid fields parameter' },
      ),
    );

    await expect(buildAchievementsModel()).rejects.toThrow('raiderio API error: 400 Bad Request');
  });

  it('propagates a non-400 static-data failure mid-scan instead of truncating', async () => {
    vi.mocked(getRaidStaticData).mockImplementation(async (exp: number) => {
      if (exp === 6) return legionStatic as never;
      throw new HttpError({
        service: 'raiderio',
        status: 500,
        attempts: 3,
        message: 'raiderio API error: 500 Internal Server Error',
      });
    });

    await expect(buildAchievementsModel()).rejects.toThrow(
      'raiderio API error: 500 Internal Server Error',
    );
  });

  it('serves ended-tier encounters from cache on the second build', async () => {
    await buildAchievementsModel();
    expect(vi.mocked(getGuildRaidEncounters)).toHaveBeenCalledTimes(1);
    await buildAchievementsModel();
    expect(vi.mocked(getGuildRaidEncounters)).toHaveBeenCalledTimes(1);
  });
});

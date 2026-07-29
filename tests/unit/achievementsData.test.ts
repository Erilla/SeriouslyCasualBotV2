import { describe, it, expect } from 'vitest';
import {
  mergeGuildSummaries,
  determineCE,
  staticDataFreshness,
  expansionIconName,
  zamimgUrl,
  iconNameFromUrl,
} from '../../src/functions/guild-info/achievementsData.js';
import type { RaidStaticData } from '../../src/services/raiderio.js';

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
});

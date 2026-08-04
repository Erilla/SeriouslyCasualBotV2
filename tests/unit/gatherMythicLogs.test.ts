import { describe, it, expect, vi } from 'vitest';
import {
  gatherMythicLogs,
  aggregateGuildHistory,
  type GatherDeps,
} from '../../src/functions/applications/mythic-logs/gatherMythicLogs.js';
import type { WclZone } from '../../src/functions/applications/mythic-logs/zoneCatalogue.js';

const zone: WclZone = {
  id: 46,
  name: 'VS / DR / MQD',
  expansion: 'Midnight',
  encounters: [
    { id: 3176, name: 'Imperator Averzian' },
    { id: 3181, name: 'Crown of the Cosmos' },
    { id: 3182, name: "Belo'ren, Child of Al'ar" },
    { id: 3183, name: 'Midnight Falls' },
  ],
};

const applicant = { region: 'eu', realm: 'draenor', name: 'Brentpriest' };
const hunter = { region: 'eu', realm: 'draenor', name: 'Brenthunter' };
const prietwo = { region: 'eu', realm: 'draenor', name: 'Brentprietwo' };

function deps(over: Partial<GatherDeps> = {}): GatherDeps {
  return {
    getZoneKills: vi.fn(async () => []),
    getEncounterKills: vi.fn(async () => [{ reportCode: 'REPORT', startTime: 1 }]),
    getRaidReports: vi.fn(async () => []),
    getReportWipes: vi.fn(async () => []),
    getMythicKillDates: vi.fn(async () => []),
    tierOrdinals: [35, 34, 33],
    paceMs: 0,
    ...over,
  };
}

describe('aggregateGuildHistory', () => {
  const kills = (character: string, entries: [string, string, string | null][]) => ({
    character,
    entries: entries.map(([bossName, firstDefeated, guildName]) => ({
      bossName,
      firstDefeated,
      guild: guildName ? { name: guildName, realm: 'kazzak' } : null,
    })),
  });

  it('groups by guild then raid, with spans, counts and characters', () => {
    const out = aggregateGuildHistory(
      [
        kills('Dödsleif', [
          ['imperator-averzian', '2026-04-23T00:00:00.000Z', 'Hindsight'],
          ['crown-of-the-cosmos', '2026-07-16T00:00:00.000Z', 'Hindsight'],
        ]),
        kills('Dödslock', [['imperator-averzian', '2026-05-01T00:00:00.000Z', 'Hindsight']]),
      ],
      [zone],
    );

    expect(out).toHaveLength(1);
    expect(out[0].guildName).toBe('Hindsight');
    expect(out[0].stints[0].raidName).toBe('VS / DR / MQD');
    expect(out[0].stints[0].kills).toBe(3);
    expect(out[0].stints[0].first).toBe('2026-04-23T00:00:00.000Z');
    expect(out[0].stints[0].last).toBe('2026-07-16T00:00:00.000Z');
    expect(out[0].stints[0].characters).toEqual(['Dödsleif', 'Dödslock']);
  });

  it('orders guilds by most recent activity', () => {
    const out = aggregateGuildHistory(
      [
        kills('X', [
          ['imperator-averzian', '2024-01-01T00:00:00.000Z', 'Old'],
          ['crown-of-the-cosmos', '2026-01-01T00:00:00.000Z', 'New'],
        ]),
      ],
      [zone],
    );
    expect(out.map((e) => e.guildName)).toEqual(['New', 'Old']);
  });

  it('ignores kills with no guild attached', () => {
    const out = aggregateGuildHistory(
      [kills('X', [['imperator-averzian', '2026-01-01T00:00:00.000Z', null]])],
      [zone],
    );
    expect(out).toEqual([]);
  });

  it('falls back to the Raider.IO slug when no WCL zone matches, made readable', () => {
    const out = aggregateGuildHistory(
      [kills('X', [['some-future-boss', '2026-01-01T00:00:00.000Z', 'G']])],
      [zone],
    );
    expect(out[0].stints[0].raidName).toBe('Some Future Boss');
  });

  /**
   * The fallback is not rare: single-boss zones are filtered out of the WCL
   * catalogue, so a one-boss raid can never match and its slug is all there is.
   * The live test sweep published `rotmire` in the guild history for that reason.
   */
  it('title-cases a single-word slug', () => {
    const out = aggregateGuildHistory(
      [kills('X', [['rotmire', '2026-06-17T18:38:09.000Z', 'G']])],
      [zone],
    );
    expect(out[0].stints[0].raidName).toBe('Rotmire');
  });

  it('keeps particles lowercase inside a slug', () => {
    const out = aggregateGuildHistory(
      [kills('X', [['crown-of-the-cosmos-reborn', '2026-01-01T00:00:00.000Z', 'G']])],
      [{ ...zone, encounters: [] }],
    );
    expect(out[0].stints[0].raidName).toBe('Crown of the Cosmos Reborn');
  });
});

describe('gatherMythicLogs', () => {
  it('attributes each kill to the character WCL says killed it', async () => {
    const tiers = await gatherMythicLogs(
      [applicant],
      [applicant, hunter, prietwo],
      [zone],
      deps({
        getZoneKills: vi.fn(async (c) =>
          c.name === 'Brentprietwo' ? [{ encounterId: 3181, totalKills: 1 }] : [],
        ),
      }),
    );
    const line = tiers[0].lines.find((l) => l.encounterId === 3181)!;
    expect(line.who).toBe('Brentprietwo');
  });

  it('keeps the earliest kill when two characters killed the same boss', async () => {
    const tiers = await gatherMythicLogs(
      [applicant],
      [hunter, prietwo],
      [zone],
      deps({
        getZoneKills: vi.fn(async () => [{ encounterId: 3181, totalKills: 1 }]),
        getMythicKillDates: vi.fn(async (c) =>
          c.name === 'Brentprietwo'
            ? [{ bossName: 'crown-of-the-cosmos', firstDefeated: '2026-04-23T00:00:00.000Z' }]
            : [{ bossName: 'crown-of-the-cosmos', firstDefeated: '2026-06-01T00:00:00.000Z' }],
        ),
      }),
    );
    const line = tiers[0].lines.find((l) => l.encounterId === 3181)!;
    expect(line.who).toBe('Brentprietwo');
    expect(line.date).toBe('2026-04-23T00:00:00.000Z');
  });

  it('still renders a kill when Raider.IO has no date for it', async () => {
    const tiers = await gatherMythicLogs(
      [applicant],
      [hunter],
      [zone],
      deps({
        getZoneKills: vi.fn(async () => [{ encounterId: 3183, totalKills: 1 }]),
        getMythicKillDates: vi.fn(async () => []),
      }),
    );
    const line = tiers[0].lines[0];
    expect(line.kind).toBe('kill');
    expect(line.date).toBeUndefined();
  });

  it('treats unknown kill dates (null) as absent rather than empty', async () => {
    const tiers = await gatherMythicLogs(
      [applicant],
      [hunter],
      [zone],
      deps({
        getZoneKills: vi.fn(async () => [{ encounterId: 3183, totalKills: 1 }]),
        getMythicKillDates: vi.fn(async () => null),
      }),
    );
    expect(tiers[0].lines[0].date).toBeUndefined();
  });

  it('adds a wipe line for the boss after the deepest kill, verified per pull', async () => {
    const tiers = await gatherMythicLogs(
      [applicant],
      [hunter],
      [zone],
      deps({
        getZoneKills: vi.fn(async () => [{ encounterId: 3182, totalKills: 1 }]),
        getRaidReports: vi.fn(async () => [{ code: 'WIPES', startTime: 10, zoneId: 46 }]),
        getReportWipes: vi.fn(async () => [
          { encounterId: 3183, fightId: 1, fightPercentage: 80.5, players: ['Brenthunter'] },
        ]),
      }),
    );
    const wipe = tiers[0].lines.find((l) => l.kind === 'wipe')!;
    expect(wipe.bossName).toBe('Midnight Falls');
    expect(wipe.who).toBe('Brenthunter');
    expect(wipe.percent).toBe(80.5);
  });

  it('ignores a wipe pull none of the account characters were in', async () => {
    const tiers = await gatherMythicLogs(
      [applicant],
      [hunter],
      [zone],
      deps({
        getZoneKills: vi.fn(async () => [{ encounterId: 3182, totalKills: 1 }]),
        getRaidReports: vi.fn(async () => [{ code: 'WIPES', startTime: 10, zoneId: 46 }]),
        getReportWipes: vi.fn(async () => [
          { encounterId: 3183, fightId: 1, fightPercentage: 80.5, players: ['SomeoneElse'] },
        ]),
      }),
    );
    expect(tiers[0].lines.some((l) => l.kind === 'wipe')).toBe(false);
  });

  it('returns no tier at all when nothing was killed or wiped on', async () => {
    expect(await gatherMythicLogs([applicant], [applicant], [zone], deps())).toEqual([]);
  });

  it('caps at five tiers', async () => {
    const zones = Array.from({ length: 8 }, (_, i) => ({ ...zone, id: 40 + i }));
    const tiers = await gatherMythicLogs(
      [applicant],
      [hunter],
      zones,
      deps({ getZoneKills: vi.fn(async () => [{ encounterId: 3176, totalKills: 1 }]) }),
    );
    expect(tiers).toHaveLength(5);
  });

  it('stops gathering once five zones have produced evidence, wasting no calls on the rest', async () => {
    const zones = Array.from({ length: 8 }, (_, i) => ({ ...zone, id: 40 + i }));
    const getZoneKills = vi.fn(async () => [{ encounterId: 3176, totalKills: 1 }]);
    const tiers = await gatherMythicLogs([applicant], [hunter], zones, deps({ getZoneKills }));
    expect(tiers).toHaveLength(5);
    // One character swept, one call per zone actually gathered — every zone
    // here yields evidence, so exactly MAX_TIERS calls should be made, not 8.
    expect(getZoneKills.mock.calls.length).toBeLessThan(8);
    expect(getZoneKills.mock.calls.length).toBe(5);
  });
});

describe('aggregateGuildHistory — naming raids outside the WCL window', () => {
  const kill = (
    bossName: string,
    firstDefeated: string,
    raid: string | null,
    guildName = 'Nightshade',
  ) => ({
    character: 'Hitoshura',
    entries: [{ bossName, firstDefeated, raid, guild: { name: guildName, realm: 'ravencrest' } }],
  });

  /**
   * Bosses from a tier older than the catalogue's three-expansion window can
   * never match a zone. Before the raid slug was carried through, each one became
   * its own one-kill "raid": the live sweep published ten separate rows
   * (Rygelon, Lords of Dread, Anduin Wrynn …) that are all Sepulcher bosses.
   */
  it('groups unmatched bosses under their raid name', () => {
    const out = aggregateGuildHistory(
      [
        kill('vigilant-guardian', '2022-03-27T00:00:00.000Z', 'sepulcher-of-the-first-ones'),
        kill('rygelon', '2022-07-24T00:00:00.000Z', 'sepulcher-of-the-first-ones'),
        kill('anduin-wrynn', '2022-07-04T00:00:00.000Z', 'sepulcher-of-the-first-ones'),
      ],
      [zone],
    );

    expect(out[0].stints).toHaveLength(1);
    expect(out[0].stints[0].raidName).toBe('Sepulcher of the First Ones');
    expect(out[0].stints[0].kills).toBe(3);
  });

  it('ignores the current tier’s opaque slug and uses the boss name', () => {
    const out = aggregateGuildHistory(
      [kill('imperator-averzian', '2026-04-23T00:00:00.000Z', 'tier-mn-1')],
      [{ ...zone, encounters: [] }],
    );
    expect(out[0].stints[0].raidName).toBe('Imperator Averzian');
  });

  it('still prefers the WCL zone name when the boss matches one', () => {
    const out = aggregateGuildHistory(
      [kill('imperator-averzian', '2026-04-23T00:00:00.000Z', 'tier-mn-1')],
      [zone],
    );
    expect(out[0].stints[0].raidName).toBe('VS / DR / MQD');
  });
});

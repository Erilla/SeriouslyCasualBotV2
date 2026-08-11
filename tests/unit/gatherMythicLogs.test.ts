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
    // No paceMs: the injected getMythicKillDates owns its own pacing now, since
    // in production it is a memo whose hits must not be slept between.
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

  describe('expansion and Cutting Edge', () => {
    const ALL_FOUR: [string, string][] = [
      ['imperator-averzian', '2026-04-23T00:00:00.000Z'],
      ['crown-of-the-cosmos', '2026-05-01T00:00:00.000Z'],
      ["belo'ren-child-of-al'ar", '2026-05-15T00:00:00.000Z'],
      ['midnight-falls', '2026-06-01T00:00:00.000Z'],
    ];

    /** Kills carrying a Raider.IO raid slug, which is how a tier end is found. */
    const raidKills = (character: string, bosses: [string, string][], raid: string | null) => ({
      character,
      entries: bosses.map(([bossName, firstDefeated]) => ({
        bossName,
        firstDefeated,
        guild: { name: 'Wraithfall', realm: 'draenor' },
        raid: raid ?? undefined,
      })),
    });

    it('names the expansion of the matched zone', () => {
      const out = aggregateGuildHistory([raidKills('Braene', ALL_FOUR, 'midnight-1')], [zone]);
      expect(out[0].stints[0].expansion).toBe('Midnight');
    });

    it('marks CE for a full clear whose last boss died before the tier ended', () => {
      const out = aggregateGuildHistory(
        [raidKills('Braene', ALL_FOUR, 'midnight-1')],
        [zone],
        new Map([['midnight-1', '2026-07-01T00:00:00.000Z']]),
      );
      expect(out[0].stints[0].cuttingEdge).toBe(true);
    });

    it('withholds CE when the last boss died after the tier ended', () => {
      const out = aggregateGuildHistory(
        [raidKills('Braene', ALL_FOUR, 'midnight-1')],
        [zone],
        new Map([['midnight-1', '2026-05-20T00:00:00.000Z']]),
      );
      expect(out[0].stints[0].cuttingEdge).toBe(false);
    });

    it('withholds CE for a partial clear however early the kills were', () => {
      const out = aggregateGuildHistory(
        [raidKills('Braene', ALL_FOUR.slice(0, 3), 'midnight-1')],
        [zone],
        new Map([['midnight-1', '2026-07-01T00:00:00.000Z']]),
      );
      expect(out[0].stints[0].cuttingEdge).toBe(false);
    });

    it('counts a full clear as CE while the tier is still running', () => {
      // The current tier's Raider.IO slug is an opaque `tier-` code that matches
      // no static raid, so no end date is known — and a full clear of a tier that
      // has not ended is CE by definition.
      const out = aggregateGuildHistory(
        [raidKills('Braene', ALL_FOUR, 'tier-mn-1')],
        [zone],
        new Map(),
      );
      expect(out[0].stints[0].cuttingEdge).toBe(true);
    });

    it('pools the account’s characters, since the stint already reports them together', () => {
      const out = aggregateGuildHistory(
        [
          raidKills('Braene', ALL_FOUR.slice(0, 2), 'midnight-1'),
          raidKills('Kiuasdk', ALL_FOUR.slice(2), 'midnight-1'),
        ],
        [zone],
        new Map([['midnight-1', '2026-07-01T00:00:00.000Z']]),
      );
      expect(out[0].stints[0].cuttingEdge).toBe(true);
      expect(out[0].stints[0].characters).toEqual(['Braene', 'Kiuasdk']);
    });

    it('judges neither expansion nor CE for a raid with no matched zone', () => {
      const out = aggregateGuildHistory(
        [raidKills('X', [['rotmire', '2026-06-17T00:00:00.000Z']], 'rotmire')],
        [zone],
        new Map([['rotmire', '2026-07-01T00:00:00.000Z']]),
      );
      expect(out[0].stints[0].expansion).toBeUndefined();
      expect(out[0].stints[0].cuttingEdge).toBeUndefined();
    });
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

/**
 * The wipe scan overlaps its tiers, and the report scans within a character. The
 * SELECTION must not move with it: whichever report resolves first, the line has
 * to be the one the serial newest-first walk would have chosen.
 */
describe('gatherMythicLogs — wipe scan runs concurrently', () => {
  const reports = [
    { code: 'NEWEST', startTime: 30, zoneId: 46 },
    { code: 'MIDDLE', startTime: 20, zoneId: 46 },
    { code: 'OLDEST', startTime: 10, zoneId: 46 },
  ];
  const wipe = (percent: number) => [
    { encounterId: 3183, fightId: 1, fightPercentage: percent, players: ['Brenthunter'] },
  ];

  it('keeps the newest matching report even when an older one resolves first', async () => {
    const tiers = await gatherMythicLogs(
      [applicant],
      [hunter],
      [zone],
      deps({
        getZoneKills: vi.fn(async () => [{ encounterId: 3182, totalKills: 1 }]),
        // Deliberately shuffled: the oldest report is returned first, so a
        // correct implementation must sort rather than trust arrival order.
        getRaidReports: vi.fn(async () => [reports[2], reports[0], reports[1]]),
        getReportWipes: vi.fn(async (code: string) => {
          // NEWEST is slowest AND has the worst pull — order must still win.
          if (code === 'NEWEST') {
            await new Promise((r) => setTimeout(r, 20));
            return wipe(90);
          }
          return wipe(5);
        }),
      }),
    );
    const line = tiers[0].lines.find((l) => l.kind === 'wipe')!;
    expect(line.reportCode).toBe('NEWEST');
    expect(line.percent).toBe(90);
  });

  it('falls through to an older report when the newest has no matching wipe', async () => {
    const tiers = await gatherMythicLogs(
      [applicant],
      [hunter],
      [zone],
      deps({
        getZoneKills: vi.fn(async () => [{ encounterId: 3182, totalKills: 1 }]),
        getRaidReports: vi.fn(async () => reports),
        getReportWipes: vi.fn(async (code: string) => (code === 'MIDDLE' ? wipe(42) : [])),
      }),
    );
    const line = tiers[0].lines.find((l) => l.kind === 'wipe')!;
    expect(line.reportCode).toBe('MIDDLE');
  });

  it('prefers the first swept character with a wipe, not the fastest', async () => {
    const getReportWipes = vi.fn(async (code: string) => {
      if (code === 'HUNTER') {
        await new Promise((r) => setTimeout(r, 20));
        return wipe(70);
      }
      return wipe(3);
    });
    const tiers = await gatherMythicLogs(
      [applicant],
      [hunter, prietwo],
      [zone],
      deps({
        getZoneKills: vi.fn(async () => [{ encounterId: 3182, totalKills: 1 }]),
        getRaidReports: vi.fn(async (c) => [
          {
            code: c.name === 'Brenthunter' ? 'HUNTER' : 'PRIETWO',
            startTime: 10,
            zoneId: 46,
          },
        ]),
        getReportWipes,
      }),
    );
    const line = tiers[0].lines.find((l) => l.kind === 'wipe')!;
    expect(line.reportCode).toBe('HUNTER');
    // Brenthunter matched, so Brentprietwo's report is never scanned at all —
    // the early exit that keeps the characters serial has to still hold.
    expect(getReportWipes.mock.calls.map((c) => c[0])).toEqual(['HUNTER']);
  });

  it('scans several tiers at once', async () => {
    const zones = Array.from({ length: 3 }, (_, i) => ({ ...zone, id: 40 + i }));
    let live = 0;
    let peak = 0;
    const tiers = await gatherMythicLogs(
      [applicant],
      [hunter],
      zones,
      deps({
        getZoneKills: vi.fn(async () => [{ encounterId: 3182, totalKills: 1 }]),
        getRaidReports: vi.fn(async (_c, zoneIds) => [
          { code: `Z${[...zoneIds][0]}`, startTime: 10, zoneId: [...zoneIds][0] },
        ]),
        getReportWipes: vi.fn(async () => {
          live++;
          peak = Math.max(peak, live);
          await new Promise((r) => setTimeout(r, 10));
          live--;
          return wipe(50);
        }),
      }),
    );
    expect(peak).toBeGreaterThan(1);
    expect(tiers.every((t) => t.lines.some((l) => l.kind === 'wipe'))).toBe(true);
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

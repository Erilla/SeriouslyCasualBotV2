import { describe, it, expect } from 'vitest';
import {
  selectSweepTargets,
  matchBossName,
  mergeBossEvidence,
  selectTierLines,
  type BossEvidence,
} from '../../src/functions/applications/mythic-logs/selectMythicReports.js';
import type { WclZone } from '../../src/functions/applications/mythic-logs/zoneCatalogue.js';

const zone: WclZone = {
  id: 44,
  name: 'Manaforge Omega',
  expansion: 'The War Within',
  encounters: [
    { id: 3129, name: 'Plexus Sentinel' },
    { id: 3131, name: "Loom'ithar" },
    { id: 3133, name: 'Fractillus' },
    { id: 3135, name: 'Dimensius, the All-Devouring' },
  ],
};

describe('selectSweepTargets', () => {
  it('always includes every application-named character, exempt from the slots', () => {
    const chosen = selectSweepTargets(
      ['brentpriest-draenor', 'brenthunter-draenor'],
      [{ name: 'Brentwartwo', realm: 'Draenor', mythicKills: 0, tiers: [46] }],
      1,
    );
    expect(chosen).toContain('brentpriest-draenor');
    expect(chosen).toContain('brenthunter-draenor');
  });

  it('prioritises characters with Mythic kills, most kills first', () => {
    const chosen = selectSweepTargets(
      ['brentpriest-draenor'],
      [
        { name: 'Brentprietwo', realm: 'Draenor', mythicKills: 6, tiers: [46] },
        { name: 'Brenthunter', realm: 'Draenor', mythicKills: 7, tiers: [46] },
        { name: 'Brentwartwo', realm: 'Draenor', mythicKills: 0, tiers: [46] },
      ],
      2,
    );
    expect(chosen.slice(1)).toEqual(['brenthunter-draenor', 'brentprietwo-draenor']);
  });

  it('fills remaining slots by new tier coverage, not recency', () => {
    const chosen = selectSweepTargets(
      ['brentpriest-draenor'],
      [
        { name: 'Brenthunter', realm: 'Draenor', mythicKills: 7, tiers: [46] },
        { name: 'Brentwartwo', realm: 'Draenor', mythicKills: 0, tiers: [46] },
        { name: 'Brentdh', realm: 'Draenor', mythicKills: 0, tiers: [44, 42] },
      ],
      2,
    );
    expect(chosen).toContain('brentdh-draenor');
    expect(chosen).not.toContain('brentwartwo-draenor');
  });

  it('does not exceed the slot count for non-named characters', () => {
    const chosen = selectSweepTargets(
      ['main-realm'],
      [
        { name: 'A', realm: 'Realm', mythicKills: 5, tiers: [1] },
        { name: 'B', realm: 'Realm', mythicKills: 4, tiers: [2] },
        { name: 'C', realm: 'Realm', mythicKills: 3, tiers: [3] },
      ],
      2,
    );
    expect(chosen).toHaveLength(3);
  });
});

describe('matchBossName', () => {
  it('matches an exact name', () => {
    expect(matchBossName(zone, 'Fractillus')?.id).toBe(3133);
  });

  it("matches Raider.IO's truncated slug for a longer WCL name", () => {
    expect(matchBossName(zone, 'dimensius')?.id).toBe(3135);
  });

  it('ignores punctuation and case differences', () => {
    expect(matchBossName(zone, 'loomithar')?.id).toBe(3131);
  });

  it('returns null rather than guessing when nothing matches', () => {
    expect(matchBossName(zone, 'some-future-boss')).toBeNull();
  });

  it('returns null when a prefix is ambiguous', () => {
    const ambiguous: WclZone = {
      ...zone,
      encounters: [
        { id: 1, name: 'The Twin Fangs' },
        { id: 2, name: 'The Twin Fangs Reborn' },
      ],
    };
    expect(matchBossName(ambiguous, 'the-twin-fangs')).not.toBeNull();
    expect(matchBossName(ambiguous, 'the-twin')).toBeNull();
  });
});

const evidence = (over: Partial<BossEvidence>): BossEvidence => ({
  encounterId: 3135,
  bossIndex: 3,
  bossName: 'Dimensius, the All-Devouring',
  who: 'Brenthunter',
  kind: 'kill',
  date: '2025-10-30',
  reportCode: 'AAA',
  isApplicantCharacter: false,
  ...over,
});

describe('mergeBossEvidence', () => {
  it('keeps the earliest kill, not a later re-kill on an alt', () => {
    const merged = mergeBossEvidence([
      evidence({ who: 'Brenthunter', date: '2026-01-01', reportCode: 'LATE' }),
      evidence({ who: 'Brentprietwo', date: '2025-10-30', reportCode: 'FIRST' }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].who).toBe('Brentprietwo');
    expect(merged[0].reportCode).toBe('FIRST');
  });

  it('prefers a kill over any wipe', () => {
    const merged = mergeBossEvidence([
      evidence({ kind: 'wipe', percent: 0.7, date: undefined, reportCode: 'WIPE' }),
      evidence({ kind: 'kill', date: '2025-10-30', reportCode: 'KILL' }),
    ]);
    expect(merged[0].kind).toBe('kill');
  });

  it('prefers the lowest boss percentage between two wipes', () => {
    const merged = mergeBossEvidence([
      evidence({ kind: 'wipe', percent: 40.1, date: undefined, reportCode: 'HIGH' }),
      evidence({ kind: 'wipe', percent: 9.2, date: undefined, reportCode: 'LOW' }),
    ]);
    expect(merged[0].reportCode).toBe('LOW');
  });

  it("keeps the applicant's own character when the evidence ties", () => {
    const merged = mergeBossEvidence([
      evidence({ who: 'Brentdh', date: '2024-11-19', reportCode: 'ALT' }),
      evidence({
        who: 'Brentpriest',
        date: '2024-11-19',
        reportCode: 'OWN',
        isApplicantCharacter: true,
      }),
    ]);
    expect(merged[0].who).toBe('Brentpriest');
  });

  it('keeps one entry per encounter', () => {
    const merged = mergeBossEvidence([
      evidence({ encounterId: 3133, bossIndex: 2 }),
      evidence({ encounterId: 3135, bossIndex: 3 }),
    ]);
    expect(merged).toHaveLength(2);
  });
});

describe('selectTierLines', () => {
  it('takes the deepest bosses first and caps at three lines', () => {
    const lines = selectTierLines(zone, [
      evidence({ encounterId: 3129, bossIndex: 0, reportCode: 'A' }),
      evidence({ encounterId: 3131, bossIndex: 1, reportCode: 'B' }),
      evidence({ encounterId: 3133, bossIndex: 2, reportCode: 'C' }),
      evidence({ encounterId: 3135, bossIndex: 3, reportCode: 'D' }),
    ]);
    expect(lines.map((l) => l.bossIndex)).toEqual([3, 2, 1]);
  });

  it('collapses a report that already covers a deeper boss', () => {
    const lines = selectTierLines(zone, [
      evidence({ encounterId: 3135, bossIndex: 3, reportCode: 'SAME' }),
      evidence({ encounterId: 3133, bossIndex: 2, reportCode: 'SAME' }),
      evidence({ encounterId: 3131, bossIndex: 1, reportCode: 'OTHER' }),
    ]);
    expect(lines.map((l) => l.reportCode)).toEqual(['SAME', 'OTHER']);
  });

  it('returns an empty array when there is no evidence', () => {
    expect(selectTierLines(zone, [])).toEqual([]);
  });
});

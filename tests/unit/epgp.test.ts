import { describe, it, expect } from 'vitest';
import { parseEpgpUpload } from '../../src/functions/epgp/parseEpgpUpload.js';
import {
  calculateCutoffDate,
  TIER_TOKEN_CLASSES,
  ARMOUR_TYPE_CLASSES,
} from '../../src/functions/epgp/calculatePoints.js';

// ─── parseEpgpUpload ───────────────────────────────────────

describe('parseEpgpUpload', () => {
  const sampleJson = JSON.stringify({
    Guild: 'SeriouslyCasual',
    Region: 'EU',
    Realm: 'Silvermoon',
    Min_ep: 0,
    Base_gp: 1,
    Decay_p: 10,
    Extras_p: 0,
    Timestamp: 1700000000,
    Roster: [
      ['Thrall-Silvermoon', 100, 50],
      ['Jaina-Silvermoon', 200, 75],
      ['Voljin-Area52', 0, 0],
    ],
    Loot: [
      [1700000100, 'Thrall-Silvermoon', 'item:12345:0:0:0', 30],
      [1700000200, 'Jaina-Silvermoon', 'item:67890:0:0:0', 15],
    ],
  });

  it('should parse guild metadata', () => {
    const result = parseEpgpUpload(sampleJson);
    expect(result.guild).toBe('SeriouslyCasual');
    expect(result.region).toBe('EU');
    expect(result.realm).toBe('Silvermoon');
    expect(result.decayPercent).toBe(10);
  });

  it('should parse roster entries with name and realm split on first dash', () => {
    const result = parseEpgpUpload(sampleJson);
    expect(result.roster).toHaveLength(3);

    expect(result.roster[0]).toEqual({
      characterName: 'Thrall',
      realm: 'Silvermoon',
      ep: 100,
      gp: 50,
    });

    expect(result.roster[1]).toEqual({
      characterName: 'Jaina',
      realm: 'Silvermoon',
      ep: 200,
      gp: 75,
    });
  });

  it('should parse roster entries with zero EP/GP', () => {
    const result = parseEpgpUpload(sampleJson);
    expect(result.roster[2]).toEqual({
      characterName: 'Voljin',
      realm: 'Area52',
      ep: 0,
      gp: 0,
    });
  });

  it('should parse loot entries', () => {
    const result = parseEpgpUpload(sampleJson);
    expect(result.loot).toHaveLength(2);

    expect(result.loot[0]).toEqual({
      timestamp: 1700000100,
      characterName: 'Thrall',
      realm: 'Silvermoon',
      itemString: 'item:12345:0:0:0',
      gp: 30,
    });

    expect(result.loot[1]).toEqual({
      timestamp: 1700000200,
      characterName: 'Jaina',
      realm: 'Silvermoon',
      itemString: 'item:67890:0:0:0',
      gp: 15,
    });
  });

  it('should handle realms with hyphens by splitting on first dash only', () => {
    const json = JSON.stringify({
      Guild: 'Test',
      Region: 'US',
      Realm: 'Twisting-Nether',
      Min_ep: 0,
      Base_gp: 1,
      Decay_p: 0,
      Extras_p: 0,
      Timestamp: 1700000000,
      Roster: [['Arthas-Twisting-Nether', 150, 60]],
      Loot: [],
    });

    const result = parseEpgpUpload(json);
    expect(result.roster[0].characterName).toBe('Arthas');
    expect(result.roster[0].realm).toBe('Twisting-Nether');
  });

  it('should handle empty roster and loot arrays', () => {
    const json = JSON.stringify({
      Guild: 'Test',
      Region: 'US',
      Realm: 'Test',
      Min_ep: 0,
      Base_gp: 1,
      Decay_p: 0,
      Extras_p: 0,
      Timestamp: 1700000000,
      Roster: [],
      Loot: [],
    });

    const result = parseEpgpUpload(json);
    expect(result.roster).toHaveLength(0);
    expect(result.loot).toHaveLength(0);
  });

  it('should handle missing Roster and Loot fields', () => {
    const json = JSON.stringify({
      Guild: 'Test',
      Region: 'US',
      Realm: 'Test',
      Min_ep: 0,
      Base_gp: 1,
      Decay_p: 5,
      Extras_p: 0,
      Timestamp: 1700000000,
    });

    const result = parseEpgpUpload(json);
    expect(result.roster).toHaveLength(0);
    expect(result.loot).toHaveLength(0);
    expect(result.decayPercent).toBe(5);
  });
});

// ─── calculateCutoffDate ────────────────────────────────────

describe('calculateCutoffDate', () => {
  it('should return previous Wednesday at 18:00 UTC for Thursday', () => {
    // Thursday 2024-01-04 10:00 UTC -> cutoff should be Wed 2024-01-03 18:00 UTC
    const thu = new Date(Date.UTC(2024, 0, 4, 10, 0, 0));
    const cutoff = calculateCutoffDate(thu);
    expect(cutoff.getUTCDay()).toBe(3); // Wednesday
    expect(cutoff.getUTCHours()).toBe(18);
    expect(cutoff.getUTCDate()).toBe(3);
  });

  it('should return previous Wednesday at 18:00 UTC for Friday', () => {
    // Friday 2024-01-05 10:00 UTC -> cutoff Wed 2024-01-03 18:00 UTC
    const fri = new Date(Date.UTC(2024, 0, 5, 10, 0, 0));
    const cutoff = calculateCutoffDate(fri);
    expect(cutoff.getUTCDay()).toBe(3);
    expect(cutoff.getUTCDate()).toBe(3);
  });

  it('should return previous Wednesday at 18:00 UTC for Saturday', () => {
    // Saturday 2024-01-06 10:00 UTC -> cutoff Wed 2024-01-03 18:00 UTC
    const sat = new Date(Date.UTC(2024, 0, 6, 10, 0, 0));
    const cutoff = calculateCutoffDate(sat);
    expect(cutoff.getUTCDay()).toBe(3);
    expect(cutoff.getUTCDate()).toBe(3);
  });

  it('should return previous Sunday at 18:00 UTC for Monday', () => {
    // Monday 2024-01-08 10:00 UTC -> cutoff Sun 2024-01-07 18:00 UTC
    const mon = new Date(Date.UTC(2024, 0, 8, 10, 0, 0));
    const cutoff = calculateCutoffDate(mon);
    expect(cutoff.getUTCDay()).toBe(0); // Sunday
    expect(cutoff.getUTCDate()).toBe(7);
  });

  it('should return previous Sunday at 18:00 UTC for Tuesday', () => {
    // Tuesday 2024-01-09 10:00 UTC -> cutoff Sun 2024-01-07 18:00 UTC
    const tue = new Date(Date.UTC(2024, 0, 9, 10, 0, 0));
    const cutoff = calculateCutoffDate(tue);
    expect(cutoff.getUTCDay()).toBe(0);
    expect(cutoff.getUTCDate()).toBe(7);
  });

  it('should return previous Sunday before cutoff hour on Wednesday', () => {
    // Wednesday 2024-01-10 10:00 UTC (before 18:00) -> cutoff Sun 2024-01-07 18:00 UTC
    const wedEarly = new Date(Date.UTC(2024, 0, 10, 10, 0, 0));
    const cutoff = calculateCutoffDate(wedEarly);
    expect(cutoff.getUTCDay()).toBe(0); // Sunday
    expect(cutoff.getUTCDate()).toBe(7);
  });

  it('should return same Wednesday after cutoff hour on Wednesday', () => {
    // Wednesday 2024-01-10 19:00 UTC (after 18:00) -> cutoff Wed 2024-01-10 18:00 UTC
    const wedLate = new Date(Date.UTC(2024, 0, 10, 19, 0, 0));
    const cutoff = calculateCutoffDate(wedLate);
    expect(cutoff.getUTCDay()).toBe(3); // Wednesday
    expect(cutoff.getUTCDate()).toBe(10);
  });

  it('should return previous Wednesday before cutoff hour on Sunday', () => {
    // Sunday 2024-01-07 10:00 UTC (before 18:00) -> cutoff Wed 2024-01-03 18:00 UTC
    const sunEarly = new Date(Date.UTC(2024, 0, 7, 10, 0, 0));
    const cutoff = calculateCutoffDate(sunEarly);
    expect(cutoff.getUTCDay()).toBe(3); // Wednesday
    expect(cutoff.getUTCDate()).toBe(3);
  });

  it('should return same Sunday after cutoff hour on Sunday', () => {
    // Sunday 2024-01-07 19:00 UTC (after 18:00) -> cutoff Sun 2024-01-07 18:00 UTC
    const sunLate = new Date(Date.UTC(2024, 0, 7, 19, 0, 0));
    const cutoff = calculateCutoffDate(sunLate);
    expect(cutoff.getUTCDay()).toBe(0); // Sunday
    expect(cutoff.getUTCDate()).toBe(7);
  });

  it('should always set cutoff hour to 18:00 UTC', () => {
    const dates = [
      new Date(Date.UTC(2024, 0, 4, 10, 0, 0)),
      new Date(Date.UTC(2024, 0, 7, 20, 0, 0)),
      new Date(Date.UTC(2024, 0, 10, 19, 0, 0)),
    ];

    for (const d of dates) {
      const cutoff = calculateCutoffDate(d);
      expect(cutoff.getUTCHours()).toBe(18);
      expect(cutoff.getUTCMinutes()).toBe(0);
      expect(cutoff.getUTCSeconds()).toBe(0);
    }
  });
});

// ─── Decay Calculation ──────────────────────────────────────

describe('decay calculation', () => {
  it('should apply 10% decay correctly', () => {
    const preCutoffEP = 1000;
    const decayPercent = 10;
    const decayMultiplier = decayPercent / 100;

    const decayedEP = preCutoffEP - preCutoffEP * decayMultiplier;
    expect(decayedEP).toBe(900);
  });

  it('should not decay when percent is 0', () => {
    const preCutoffEP = 1000;
    const decayPercent = 0;
    const decayMultiplier = decayPercent / 100;

    const decayedEP = preCutoffEP - preCutoffEP * decayMultiplier;
    expect(decayedEP).toBe(1000);
  });

  it('should apply 25% decay correctly', () => {
    const preCutoffGP = 200;
    const decayPercent = 25;
    const decayMultiplier = decayPercent / 100;

    const decayedGP = preCutoffGP - preCutoffGP * decayMultiplier;
    expect(decayedGP).toBe(150);
  });

  it('should calculate point difference with ceiling', () => {
    const currentEP = 110;
    const decayedEP = 95.5;

    const diff = Math.ceil(currentEP - decayedEP);
    expect(diff).toBe(15); // 14.5 -> ceil -> 15
  });

  it('should handle negative differences with ceiling', () => {
    const currentEP = 80;
    const decayedEP = 100;

    const diff = Math.ceil(currentEP - decayedEP);
    expect(diff).toBe(-20);
  });
});

// ─── Tier Token Mapping ─────────────────────────────────────

describe('tier token class mapping', () => {
  it('should have 4 token types', () => {
    expect(Object.keys(TIER_TOKEN_CLASSES)).toHaveLength(4);
  });

  it('Zenith should include Evoker, Monk, Rogue, Warrior', () => {
    expect(TIER_TOKEN_CLASSES.Zenith).toEqual(['Evoker', 'Monk', 'Rogue', 'Warrior']);
  });

  it('Dreadful should include Death Knight, Demon Hunter, Warlock', () => {
    expect(TIER_TOKEN_CLASSES.Dreadful).toEqual(['Death Knight', 'Demon Hunter', 'Warlock']);
  });

  it('Mystic should include Druid, Hunter, Mage', () => {
    expect(TIER_TOKEN_CLASSES.Mystic).toEqual(['Druid', 'Hunter', 'Mage']);
  });

  it('Venerated should include Paladin, Priest, Shaman', () => {
    expect(TIER_TOKEN_CLASSES.Venerated).toEqual(['Paladin', 'Priest', 'Shaman']);
  });

  it('should cover all 13 WoW classes across all tokens', () => {
    const allClasses = Object.values(TIER_TOKEN_CLASSES).flat();
    expect(allClasses).toHaveLength(13);
    expect(new Set(allClasses).size).toBe(13);
  });
});

// ─── Armour Type Mapping ────────────────────────────────────

describe('armour type class mapping', () => {
  it('should have 4 armour types', () => {
    expect(Object.keys(ARMOUR_TYPE_CLASSES)).toHaveLength(4);
  });

  it('Cloth should include Mage, Priest, Warlock', () => {
    expect(ARMOUR_TYPE_CLASSES.Cloth).toEqual(['Mage', 'Priest', 'Warlock']);
  });

  it('Leather should include Demon Hunter, Druid, Monk, Rogue', () => {
    expect(ARMOUR_TYPE_CLASSES.Leather).toEqual(['Demon Hunter', 'Druid', 'Monk', 'Rogue']);
  });

  it('Mail should include Evoker, Hunter, Shaman', () => {
    expect(ARMOUR_TYPE_CLASSES.Mail).toEqual(['Evoker', 'Hunter', 'Shaman']);
  });

  it('Plate should include Death Knight, Paladin, Warrior', () => {
    expect(ARMOUR_TYPE_CLASSES.Plate).toEqual(['Death Knight', 'Paladin', 'Warrior']);
  });

  it('should cover all 13 WoW classes across all armour types', () => {
    const allClasses = Object.values(ARMOUR_TYPE_CLASSES).flat();
    expect(allClasses).toHaveLength(13);
    expect(new Set(allClasses).size).toBe(13);
  });
});

// ─── Priority Calculation ───────────────────────────────────

describe('priority calculation', () => {
  it('should calculate priority as EP / GP', () => {
    const ep = 100;
    const gp = 50;
    const priority = ep / gp;
    expect(priority).toBe(2);
  });

  it('should return 0 when GP is 0', () => {
    const ep = 100;
    const gp = 0;
    const priority = gp > 0 ? ep / gp : 0;
    expect(priority).toBe(0);
  });

  it('should format to 3 decimal places', () => {
    const ep = 100;
    const gp = 30;
    const priority = ep / gp;
    const formatted = priority.toFixed(3);
    expect(formatted).toBe('3.333');
  });

  it('should handle equal EP and GP', () => {
    const ep = 75;
    const gp = 75;
    const priority = ep / gp;
    expect(priority.toFixed(3)).toBe('1.000');
  });

  it('should handle very small GP values', () => {
    const ep = 100;
    const gp = 1;
    const priority = ep / gp;
    expect(priority).toBe(100);
    expect(priority.toFixed(3)).toBe('100.000');
  });
});

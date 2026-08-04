import { describe, it, expect } from 'vitest';
import {
  selectMythicRaidZones,
  type WclExpansion,
} from '../../src/functions/applications/mythic-logs/zoneCatalogue.js';

const MYTHIC = { id: 5, name: 'Mythic' };
const DUNGEON = { id: 10, name: 'Dungeon' };
const bosses = (...names: string[]) => names.map((name, i) => ({ id: 100 + i, name }));

const expansions: WclExpansion[] = [
  {
    id: 7,
    name: 'Midnight',
    zones: [
      { id: 46, name: 'VS / DR / MQD', difficulties: [MYTHIC], encounters: bosses('A', 'B') },
      { id: 47, name: 'Mythic+ Season 1', difficulties: [DUNGEON], encounters: bosses('D1', 'D2') },
      {
        id: 48,
        name: 'VS / DR / MQD (Beta)',
        difficulties: [MYTHIC],
        encounters: bosses('A', 'B'),
      },
      { id: 50, name: 'Sporefall', difficulties: [MYTHIC], encounters: bosses('Rotmire') },
      {
        id: 509,
        name: 'Complete Raids (VS)',
        difficulties: [MYTHIC],
        encounters: bosses('X', 'Y'),
      },
      { id: 52, name: 'Dummy Dome', difficulties: [MYTHIC], encounters: bosses('S', 'T') },
    ],
  },
  {
    id: 6,
    name: 'The War Within',
    zones: [
      { id: 44, name: 'Manaforge Omega', difficulties: [MYTHIC], encounters: bosses('P', 'Q') },
    ],
  },
  {
    id: 5,
    name: 'Dragonflight',
    zones: [{ id: 35, name: 'Amirdrassil', difficulties: [MYTHIC], encounters: bosses('G', 'F') }],
  },
  {
    id: 4,
    name: 'Shadowlands',
    zones: [{ id: 29, name: 'Sepulcher', difficulties: [MYTHIC], encounters: bosses('V', 'J') }],
  },
];

describe('selectMythicRaidZones', () => {
  it('keeps only zones from the newest three expansions', () => {
    const names = selectMythicRaidZones(expansions).map((z) => z.name);
    expect(names).toEqual(
      expect.arrayContaining(['VS / DR / MQD', 'Manaforge Omega', 'Amirdrassil']),
    );
    expect(names).not.toContain('Sepulcher');
  });

  it('excludes dungeon-only zones', () => {
    expect(selectMythicRaidZones(expansions).map((z) => z.id)).not.toContain(47);
  });

  it('excludes the >= 500 Complete Raids rollups', () => {
    expect(selectMythicRaidZones(expansions).map((z) => z.id)).not.toContain(509);
  });

  it('excludes PTR, Beta and Dummy Dome zones', () => {
    const ids = selectMythicRaidZones(expansions).map((z) => z.id);
    expect(ids).not.toContain(48);
    expect(ids).not.toContain(52);
  });

  it('excludes single-boss zones', () => {
    expect(selectMythicRaidZones(expansions).map((z) => z.id)).not.toContain(50);
  });

  it('carries the expansion name and preserves boss order', () => {
    const zone = selectMythicRaidZones(expansions).find((z) => z.id === 44)!;
    expect(zone.expansion).toBe('The War Within');
    expect(zone.encounters.map((e) => e.name)).toEqual(['P', 'Q']);
  });

  it('honours a custom expansion depth', () => {
    expect(selectMythicRaidZones(expansions, 1).map((z) => z.id)).toEqual([46]);
  });

  it('does not alias the source encounters array', () => {
    const fixture: WclExpansion[] = [
      {
        id: 1,
        name: 'Test Expansion',
        zones: [
          {
            id: 10,
            name: 'Test Raid',
            difficulties: [MYTHIC],
            encounters: bosses('First', 'Second'),
          },
        ],
      },
    ];
    const originalOrder = fixture[0].zones[0].encounters.map((e) => e.name);

    const zone = selectMythicRaidZones(fixture).find((z) => z.id === 10)!;
    zone.encounters.reverse();

    expect(fixture[0].zones[0].encounters.map((e) => e.name)).toEqual(originalOrder);
  });
});

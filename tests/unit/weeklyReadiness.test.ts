import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/config.js', () => ({
  config: { weeklyGearStaleHours: 48 },
}));

import {
  buildReadinessExceptions,
  getDungeonVaultChoices,
  getUnlockedChoiceCount,
} from '../../src/functions/raids/weeklyReadiness.js';
import type { MythicPlusRun } from '../../src/services/raiderio.js';

function runs(levels: number[]): MythicPlusRun[] {
  return levels.map((mythic_level) => ({
    dungeon: 'The Stonevault',
    short_name: 'SV',
    mythic_level,
    num_keystone_upgrades: 0,
    score: 0,
  }));
}

describe('weekly readiness rules', () => {
  it('uses the first, fourth, and eighth highest runs for Dungeon Vault choices', () => {
    expect(getDungeonVaultChoices(runs([9, 10, 8, 9, 10, 9, 10, 10]))).toEqual([10, 10, 8]);
    expect(getDungeonVaultChoices(runs([10, 9, 9, 9]))).toEqual([10, 9, null]);
  });

  it('counts only unlocked WoW Audit Vault choices', () => {
    expect(getUnlockedChoiceCount({ option_1: 259, option_2: null, option_3: 272 })).toBe(2);
  });

  it('reports only real readiness exceptions and treats untimed +10 as completed', () => {
    const result = buildReadinessExceptions(
      [
        {
          characterName: 'Untimedten',
          runs: runs([10]),
          lastCrawledAt: '2026-07-30T11:00:00Z',
          equipment: {
            equipped_items: [
              { slot: { type: 'BACK' }, item: { name: 'Cape' }, enchantments: [] },
              {
                slot: { type: 'HEAD' },
                item: { name: 'Helm' },
                sockets: [{ socket_type: 'PRISMATIC', item: undefined }],
              },
            ],
          },
        },
        {
          characterName: 'Nineten',
          runs: runs([9]),
          lastCrawledAt: '2026-07-30T11:00:00Z',
          equipment: { equipped_items: [] },
        },
        {
          characterName: 'Stalegear',
          runs: runs([10]),
          lastCrawledAt: '2026-07-27T11:00:00Z',
          equipment: {
            equipped_items: [
              { slot: { type: 'CHEST' }, item: { name: 'Chest' }, enchantments: [] },
            ],
          },
        },
      ],
      new Date('2026-07-30T12:00:00Z'),
    );

    expect(result).not.toContain('## No completed +10\n- Untimedten');
    expect(result).toContain('## No completed +10');
    expect(result).toContain('- Nineten');
    expect(result).toContain('## Dungeon Vault below +10');
    expect(result).toContain('- Nineten: +9 / - / -');
    expect(result).toContain('## Gear progression');
    expect(result).toContain('Untimedten: empty socket (HEAD); missing enchant (BACK)');
    expect(result).toContain('## Needs verification');
    expect(result).toContain('- Stalegear');
    expect(result).not.toContain('Stalegear: missing enchant');
  });

  it('returns null when every readiness list is empty', () => {
    expect(
      buildReadinessExceptions(
        [
          {
            characterName: 'Ready',
            runs: runs([10, 10, 10, 10, 10, 10, 10, 10]),
            lastCrawledAt: '2026-07-30T11:00:00Z',
            equipment: { equipped_items: [] },
          },
        ],
        new Date('2026-07-30T12:00:00Z'),
      ),
    ).toBeNull();
  });
});

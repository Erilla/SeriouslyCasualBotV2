import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/config.js', () => ({
  config: {
    wowAuditApiSecret: 'test-api-secret',
  },
}));

import { generateGreatVaultReport } from '../../src/functions/raids/alertHighestMythicPlusDone.js';
import type { WowAuditHistoricalEntry } from '../../src/services/wowaudit.js';
import type { WeeklyReadinessRow } from '../../src/functions/raids/weeklyReadiness.js';
import type { MythicPlusRun } from '../../src/services/raiderio.js';

function weeklyRuns(levels: number[]): MythicPlusRun[] {
  return levels.map((mythic_level) => ({
    dungeon: 'The Stonevault',
    short_name: 'SV',
    mythic_level,
    num_keystone_upgrades: 0,
    score: 0,
  }));
}

function readinessRow(name: string, runs = weeklyRuns([])): WeeklyReadinessRow {
  return {
    characterName: name,
    runs,
    lastCrawledAt: null,
    equipment: null,
  };
}

describe('generateGreatVaultReport', () => {
  it('renders Raid and World unlock counts with Dungeon choices from weekly runs', async () => {
    // Real /historical_data entry shape: { id, name, realm, data }.
    // Each vault option is the reward item level as a number (or null for an
    // unfilled slot) — NOT a nested object.
    const historicalData: WowAuditHistoricalEntry[] = [
      {
        id: 100,
        name: 'Testchar',
        realm: 'silvermoon',
        data: {
          vault_options: {
            raids: { option_1: 259, option_2: 269, option_3: 272 },
            dungeons: { option_1: 272, option_2: null, option_3: null },
            world: { option_1: 259, option_2: null, option_3: null },
          },
        },
      },
    ];

    const report = await generateGreatVaultReport(
      [readinessRow('Testchar', weeklyRuns([10, 10, 9, 9]))],
      historicalData,
    );

    const line = report.split('\n').find((l) => l.startsWith('Testchar'));
    expect(line).toBeDefined();
    expect(line).toContain('3');
    expect(line).toContain('+10 / +9 / -');
    expect(line).toContain('1');
    expect(line).not.toContain('259/-/-');
  });

  it('counts only filled first and second Raid and World options', async () => {
    const historicalData: WowAuditHistoricalEntry[] = [
      {
        id: 101,
        name: 'Testchar',
        realm: 'silvermoon',
        data: {
          vault_options: {
            raids: { option_1: 259, option_2: 269, option_3: null },
            world: { option_1: 259, option_2: 269, option_3: null },
          },
        },
      },
    ];

    const report = await generateGreatVaultReport([readinessRow('Testchar')], historicalData);
    const line = report.split('\n').find((l) => l.startsWith('Testchar'));

    expect(line).toContain('2');
    expect(line).not.toContain('259/269/-');
  });

  it('renders zeroes when a raider has no matching historical entry', async () => {
    const report = await generateGreatVaultReport([readinessRow('Ghostchar')], []);
    const line = report.split('\n').find((l) => l.startsWith('Ghostchar'));
    expect(line).toBeDefined();
    expect(line).toContain('0');
  });
});

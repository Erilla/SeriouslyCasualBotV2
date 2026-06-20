import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/config.js', () => ({
  config: {
    wowAuditApiSecret: 'test-api-secret',
  },
}));

import { generateGreatVaultReport } from '../../src/functions/raids/alertHighestMythicPlusDone.js';
import type { RaiderRow } from '../../src/types/index.js';
import type { WowAuditHistoricalEntry } from '../../src/services/wowaudit.js';

function raider(name: string): RaiderRow {
  return {
    id: 1,
    character_name: name,
    realm: 'silvermoon',
    region: 'eu',
    rank: null,
    class: null,
    discord_user_id: null,
    message_id: null,
    missing_since: null,
  };
}

describe('generateGreatVaultReport', () => {
  it('maps each raider to their vault options using the WoW Audit entry shape', async () => {
    // Real /historical_data entry shape: { id, name, realm, data }.
    const historicalData: WowAuditHistoricalEntry[] = [
      {
        id: 100,
        name: 'Testchar',
        realm: 'silvermoon',
        data: {
          vault_options: {
            raids: { option_1: { level: 1 }, option_2: null, option_3: null },
            dungeons: { option_1: { level: 8 }, option_2: null, option_3: null },
            world: { option_1: null, option_2: null, option_3: null },
          },
        },
      },
    ];

    const report = await generateGreatVaultReport([raider('Testchar')], historicalData);

    const line = report.split('\n').find((l) => l.startsWith('Testchar'));
    expect(line).toBeDefined();
    // raid option_1 level 1, dungeon option_1 level 8
    expect(line).toContain('1/-/-');
    expect(line).toContain('8/-/-');
  });

  it('does not throw when a raider has no matching historical entry', async () => {
    const report = await generateGreatVaultReport([raider('Ghostchar')], []);
    const line = report.split('\n').find((l) => l.startsWith('Ghostchar'));
    expect(line).toBeDefined();
    expect(line).toContain('-/-/-');
  });
});

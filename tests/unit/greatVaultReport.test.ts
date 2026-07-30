import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  getOrCreateChannel: vi.fn(),
  getHistoricalData: vi.fn(),
  getPreviousWeekProfile: vi.fn(),
  getCharacterEquipment: vi.fn(),
}));

vi.mock('../../src/config.js', () => ({
  config: {
    guildId: 'guild-123',
    weeklyGearStaleHours: 48,
    wowAuditApiSecret: 'test-api-secret',
  },
}));

vi.mock('../../src/database/db.js', () => ({ getDatabase: mocks.getDatabase }));
vi.mock('../../src/functions/channels.js', () => ({
  getOrCreateChannel: mocks.getOrCreateChannel,
}));
vi.mock('../../src/services/wowaudit.js', () => ({ getHistoricalData: mocks.getHistoricalData }));
vi.mock('../../src/services/raiderio.js', () => ({
  getPreviousWeekProfile: mocks.getPreviousWeekProfile,
}));
vi.mock('../../src/services/blizzard.js', () => ({
  getCharacterEquipment: mocks.getCharacterEquipment,
}));
vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  alertHighestMythicPlusDone,
  generateGreatVaultReport,
} from '../../src/functions/raids/alertHighestMythicPlusDone.js';
import type { WowAuditHistoricalEntry } from '../../src/services/wowaudit.js';
import * as weeklyReadiness from '../../src/functions/raids/weeklyReadiness.js';
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

    expect(report).toContain('Dungeon keys');
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

describe('alertHighestMythicPlusDone', () => {
  const raider = {
    character_name: 'Testchar',
    region: 'eu',
    realm: 'silvermoon',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDatabase.mockReturnValue({
      prepare: vi.fn(() => ({ all: () => [raider] })),
    });
    mocks.getHistoricalData.mockResolvedValue([]);
    mocks.getCharacterEquipment.mockResolvedValue({ equipped_items: [] });
  });

  it('posts readiness exceptions separately after the weekly report attachments', async () => {
    const channel = { send: vi.fn().mockResolvedValue(undefined) };
    mocks.getOrCreateChannel.mockResolvedValue(channel);
    mocks.getPreviousWeekProfile.mockResolvedValue({
      runs: weeklyRuns([9]),
      lastCrawledAt: new Date().toISOString(),
    });
    const client = { guilds: { fetch: vi.fn().mockResolvedValue({}) } };

    await alertHighestMythicPlusDone(client as never);

    expect(channel.send).toHaveBeenCalledTimes(2);
    const firstPayload = channel.send.mock.calls[0][0];
    expect(firstPayload.content).toContain('Weekly Reports');
    expect(firstPayload.files).toHaveLength(2);
    expect(channel.send).toHaveBeenNthCalledWith(2, {
      content: expect.stringContaining('Weekly Readiness Exceptions'),
    });
  });

  it('posts only the weekly report attachments when no readiness exceptions exist', async () => {
    const channel = { send: vi.fn().mockResolvedValue(undefined) };
    mocks.getOrCreateChannel.mockResolvedValue(channel);
    mocks.getPreviousWeekProfile.mockResolvedValue({
      runs: weeklyRuns([10, 10, 10, 10, 10, 10, 10, 10]),
      lastCrawledAt: new Date().toISOString(),
    });
    const client = { guilds: { fetch: vi.fn().mockResolvedValue({}) } };

    await alertHighestMythicPlusDone(client as never);

    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  it('sends report attachments when building readiness exceptions fails', async () => {
    const channel = { send: vi.fn().mockResolvedValue(undefined) };
    mocks.getOrCreateChannel.mockResolvedValue(channel);
    mocks.getPreviousWeekProfile.mockResolvedValue({
      runs: weeklyRuns([9]),
      lastCrawledAt: new Date().toISOString(),
    });
    const readinessSpy = vi
      .spyOn(weeklyReadiness, 'buildReadinessExceptions')
      .mockImplementation(() => {
        throw new Error('readiness formatter failed');
      });
    const client = { guilds: { fetch: vi.fn().mockResolvedValue({}) } };

    try {
      await expect(alertHighestMythicPlusDone(client as never)).resolves.toBeUndefined();
      expect(channel.send).toHaveBeenCalledTimes(1);
      expect(channel.send).toHaveBeenCalledWith(
        expect.objectContaining({ files: expect.any(Array) }),
      );
    } finally {
      readinessSpy.mockRestore();
    }
  });
});

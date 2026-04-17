import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../src/database/db.js';
import type { Client } from 'discord.js';
import type { RaiderIoMember } from '../../src/services/raiderio.js';

// Mock the raiderio service
vi.mock('../../src/services/raiderio.js', () => ({
  getGuildRoster: vi.fn(),
}));

// Mock the logger
vi.mock('../../src/services/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock config (needed by raiderio import chain)
vi.mock('../../src/config.js', () => ({
  config: {
    raiderIoGuildIds: 'test-guild-id',
  },
}));

import { syncRaiders } from '../../src/functions/raids/syncRaiders.js';
import { getGuildRoster } from '../../src/services/raiderio.js';
import { logger } from '../../src/services/logger.js';

const mockClient = {} as Client;
const mockedGetGuildRoster = vi.mocked(getGuildRoster);

function makeMember(name: string, rank = 3, realm = 'silvermoon', region = 'eu', charClass = 'Warrior'): RaiderIoMember {
  return {
    rank,
    character: { name, realm, region, class: charClass },
  };
}

beforeEach(() => {
  closeDatabase();
  initDatabase(':memory:');
  vi.clearAllMocks();
});

afterEach(() => {
  closeDatabase();
});

describe('syncRaiders', () => {
  it('should add new raiders when they appear in API but not in DB', async () => {
    mockedGetGuildRoster.mockResolvedValue([
      makeMember('Newchar', 3, 'silvermoon', 'eu', 'Mage'),
    ]);

    await syncRaiders(mockClient);

    const db = getDatabase();
    const raiders = db.prepare('SELECT * FROM raiders').all() as Array<{
      character_name: string;
      realm: string;
      region: string;
      rank: number;
      class: string;
      discord_user_id: string | null;
    }>;

    expect(raiders).toHaveLength(1);
    expect(raiders[0].character_name).toBe('Newchar');
    expect(raiders[0].realm).toBe('silvermoon');
    expect(raiders[0].region).toBe('eu');
    expect(raiders[0].rank).toBe(3);
    expect(raiders[0].class).toBe('Mage');
    expect(raiders[0].discord_user_id).toBeNull();
  });

  it('should set missing_since when a raider disappears from API', async () => {
    const db = getDatabase();
    db.prepare(
      'INSERT INTO raiders (character_name, realm, region) VALUES (?, ?, ?)',
    ).run('OldRaider', 'silvermoon', 'eu');

    // API returns empty (OldRaider not in API anymore)
    mockedGetGuildRoster.mockResolvedValue([]);

    await syncRaiders(mockClient);

    const raider = db.prepare('SELECT * FROM raiders WHERE character_name = ?').get('OldRaider') as {
      missing_since: string | null;
    };

    expect(raider.missing_since).not.toBeNull();
  });

  it('should clear missing_since when a raider returns to API', async () => {
    const db = getDatabase();
    db.prepare(
      'INSERT INTO raiders (character_name, realm, region, missing_since) VALUES (?, ?, ?, ?)',
    ).run('ReturnedRaider', 'silvermoon', 'eu', new Date().toISOString());

    mockedGetGuildRoster.mockResolvedValue([
      makeMember('ReturnedRaider'),
    ]);

    await syncRaiders(mockClient);

    const raider = db.prepare('SELECT * FROM raiders WHERE character_name = ?').get('ReturnedRaider') as {
      missing_since: string | null;
    };

    expect(raider.missing_since).toBeNull();
  });

  it('should exclude ignored characters from sync', async () => {
    const db = getDatabase();
    db.prepare('INSERT INTO ignored_characters (character_name) VALUES (?)').run('IgnoredAlt');

    mockedGetGuildRoster.mockResolvedValue([
      makeMember('IgnoredAlt'),
      makeMember('ValidRaider'),
    ]);

    await syncRaiders(mockClient);

    const raiders = db.prepare('SELECT * FROM raiders').all() as Array<{ character_name: string }>;

    expect(raiders).toHaveLength(1);
    expect(raiders[0].character_name).toBe('ValidRaider');
  });

  it('should auto-populate discord_user_id from identity map', async () => {
    const db = getDatabase();
    db.prepare(
      'INSERT INTO raider_identity_map (character_name, discord_user_id) VALUES (?, ?)',
    ).run('MappedChar', '123456789');

    mockedGetGuildRoster.mockResolvedValue([
      makeMember('MappedChar'),
    ]);

    await syncRaiders(mockClient);

    const raider = db.prepare('SELECT * FROM raiders WHERE character_name = ?').get('MappedChar') as {
      discord_user_id: string | null;
    };

    expect(raider.discord_user_id).toBe('123456789');
  });

  it('should handle case-insensitive matching for ignored characters', async () => {
    const db = getDatabase();
    db.prepare('INSERT INTO ignored_characters (character_name) VALUES (?)').run('ignoredchar');

    mockedGetGuildRoster.mockResolvedValue([
      makeMember('IgnoredChar'), // Different case than DB
      makeMember('ValidRaider'),
    ]);

    await syncRaiders(mockClient);

    const raiders = db.prepare('SELECT * FROM raiders').all() as Array<{ character_name: string }>;

    expect(raiders).toHaveLength(1);
    expect(raiders[0].character_name).toBe('ValidRaider');
  });

  it('should not duplicate existing raiders', async () => {
    const db = getDatabase();
    db.prepare(
      'INSERT INTO raiders (character_name, realm, region) VALUES (?, ?, ?)',
    ).run('ExistingRaider', 'silvermoon', 'eu');

    mockedGetGuildRoster.mockResolvedValue([
      makeMember('ExistingRaider'),
    ]);

    await syncRaiders(mockClient);

    const raiders = db.prepare('SELECT * FROM raiders').all() as Array<{ character_name: string }>;

    expect(raiders).toHaveLength(1);
  });

  it('should warn when a raider has been missing for over 24 hours', async () => {
    const db = getDatabase();
    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25 hours ago
    db.prepare(
      'INSERT INTO raiders (character_name, realm, region, missing_since) VALUES (?, ?, ?, ?)',
    ).run('LongGoneRaider', 'silvermoon', 'eu', oldDate);

    mockedGetGuildRoster.mockResolvedValue([]);

    await syncRaiders(mockClient);

    expect(logger.warn).toHaveBeenCalledWith(
      'SyncRaiders',
      expect.stringContaining('LongGoneRaider'),
    );
  });

  it('should not warn when a raider is missing for less than 24 hours', async () => {
    const db = getDatabase();
    const recentDate = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2 hours ago
    db.prepare(
      'INSERT INTO raiders (character_name, realm, region, missing_since) VALUES (?, ?, ?, ?)',
    ).run('RecentlyGoneRaider', 'silvermoon', 'eu', recentDate);

    mockedGetGuildRoster.mockResolvedValue([]);

    await syncRaiders(mockClient);

    expect(logger.warn).not.toHaveBeenCalledWith(
      'SyncRaiders',
      expect.stringContaining('RecentlyGoneRaider'),
    );
  });

  it('should log sync summary', async () => {
    mockedGetGuildRoster.mockResolvedValue([
      makeMember('NewRaider'),
    ]);

    await syncRaiders(mockClient);

    expect(logger.info).toHaveBeenCalledWith(
      'SyncRaiders',
      expect.stringContaining('Sync complete'),
    );
  });

  it('should handle API failure gracefully', async () => {
    mockedGetGuildRoster.mockRejectedValue(new Error('Network error'));

    await syncRaiders(mockClient);

    expect(logger.error).toHaveBeenCalledWith(
      'SyncRaiders',
      'Failed to fetch guild roster from Raider.io',
      expect.any(Error),
    );
  });

  it('should handle case-insensitive identity map lookup', async () => {
    const db = getDatabase();
    db.prepare(
      'INSERT INTO raider_identity_map (character_name, discord_user_id) VALUES (?, ?)',
    ).run('mappedchar', '987654321');

    mockedGetGuildRoster.mockResolvedValue([
      makeMember('MappedChar'), // Different case
    ]);

    await syncRaiders(mockClient);

    const raider = db.prepare('SELECT * FROM raiders WHERE character_name = ?').get('MappedChar') as {
      discord_user_id: string | null;
    };

    expect(raider.discord_user_id).toBe('987654321');
  });
});

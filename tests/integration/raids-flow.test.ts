import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../src/database/db.js';
import type { Client } from 'discord.js';
import type { RaiderIoMember } from '../../src/services/raiderio.js';

// Mock the Raider.io service
vi.mock('../../src/services/raiderio.js', () => ({
  getGuildRoster: vi.fn(),
}));

// Mock the logger so sync doesn't crash without a real Discord client
vi.mock('../../src/services/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock config (required by raiderio import chain)
vi.mock('../../src/config.js', () => ({
  config: {
    raiderIoGuildIds: 'test-guild-id',
  },
}));

import { syncRaiders } from '../../src/functions/raids/syncRaiders.js';
import { getGuildRoster } from '../../src/services/raiderio.js';

const mockClient = {} as Client;
const mockedGetGuildRoster = vi.mocked(getGuildRoster);

function makeMember(
  name: string,
  rank = 3,
  realm = 'silvermoon',
  region = 'eu',
  charClass = 'Warrior',
): RaiderIoMember {
  return {
    rank,
    character: { name, realm, region, class: charClass },
  };
}

describe('raids roster sync flow (integration)', () => {
  beforeEach(() => {
    closeDatabase();
    initDatabase(':memory:');
    vi.clearAllMocks();
  });

  afterEach(() => {
    closeDatabase();
  });

  it('should add new raiders from API', async () => {
    mockedGetGuildRoster.mockResolvedValue([
      makeMember('Testchar', 3, 'silvermoon', 'eu', 'Paladin'),
      makeMember('Anotherchar', 4, 'silvermoon', 'eu', 'Druid'),
    ]);

    await syncRaiders(mockClient);

    const db = getDatabase();
    const raiders = db
      .prepare('SELECT character_name, realm, region, rank, class FROM raiders ORDER BY character_name')
      .all() as Array<{
        character_name: string;
        realm: string;
        region: string;
        rank: number;
        class: string;
      }>;

    expect(raiders).toHaveLength(2);
    const names = raiders.map((r) => r.character_name);
    expect(names).toContain('Testchar');
    expect(names).toContain('Anotherchar');

    const testchar = raiders.find((r) => r.character_name === 'Testchar')!;
    expect(testchar.realm).toBe('silvermoon');
    expect(testchar.region).toBe('eu');
    expect(testchar.rank).toBe(3);
    expect(testchar.class).toBe('Paladin');
  });

  it('should set missing_since for raiders not in API', async () => {
    const db = getDatabase();
    db.prepare(
      'INSERT INTO raiders (character_name, realm, region) VALUES (?, ?, ?)',
    ).run('GoneMember', 'silvermoon', 'eu');

    // API returns empty — GoneMember is no longer in the roster
    mockedGetGuildRoster.mockResolvedValue([]);

    await syncRaiders(mockClient);

    const raider = db
      .prepare('SELECT missing_since FROM raiders WHERE character_name = ?')
      .get('GoneMember') as { missing_since: string | null };

    expect(raider.missing_since).not.toBeNull();
    // Should be a valid ISO timestamp
    expect(new Date(raider.missing_since!).getTime()).not.toBeNaN();
  });

  it('should clear missing_since when raider returns', async () => {
    const db = getDatabase();
    const missingSince = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2 hours ago
    db.prepare(
      'INSERT INTO raiders (character_name, realm, region, missing_since) VALUES (?, ?, ?, ?)',
    ).run('ReturnedMember', 'silvermoon', 'eu', missingSince);

    // Raider is back in the API response
    mockedGetGuildRoster.mockResolvedValue([makeMember('ReturnedMember')]);

    await syncRaiders(mockClient);

    const raider = db
      .prepare('SELECT missing_since FROM raiders WHERE character_name = ?')
      .get('ReturnedMember') as { missing_since: string | null };

    expect(raider.missing_since).toBeNull();
  });

  it('should auto-link from identity map', async () => {
    const db = getDatabase();
    db.prepare(
      'INSERT INTO raider_identity_map (character_name, discord_user_id) VALUES (?, ?)',
    ).run('Linkedchar', '111222333444555666');

    mockedGetGuildRoster.mockResolvedValue([makeMember('Linkedchar')]);

    await syncRaiders(mockClient);

    const raider = db
      .prepare('SELECT discord_user_id FROM raiders WHERE character_name = ?')
      .get('Linkedchar') as { discord_user_id: string | null };

    expect(raider.discord_user_id).toBe('111222333444555666');
  });

  it('should not add ignored characters', async () => {
    const db = getDatabase();
    db.prepare('INSERT INTO ignored_characters (character_name) VALUES (?)').run('Ignoredchar');

    mockedGetGuildRoster.mockResolvedValue([
      makeMember('Ignoredchar'),
      makeMember('Regularchar'),
    ]);

    await syncRaiders(mockClient);

    const raiders = db
      .prepare('SELECT character_name FROM raiders')
      .all() as Array<{ character_name: string }>;

    const names = raiders.map((r) => r.character_name);
    expect(names).not.toContain('Ignoredchar');
    expect(names).toContain('Regularchar');
    expect(raiders).toHaveLength(1);
  });
});

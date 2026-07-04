import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { closeDatabase, getDatabase } from '../../src/database/db.js';
import { createTables } from '../../src/database/schema.js';

vi.mock('../../src/services/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { linkCharacterIdentity } from '../../src/functions/raids/linkCharacterIdentity.js';
import type { RaiderIdentityMapRow } from '../../src/types/index.js';

function getMapping(name: string): RaiderIdentityMapRow | undefined {
  return getDatabase()
    .prepare('SELECT * FROM raider_identity_map WHERE character_name = ? COLLATE NOCASE')
    .get(name) as RaiderIdentityMapRow | undefined;
}

describe('linkCharacterIdentity', () => {
  beforeEach(() => {
    closeDatabase();
    createTables(getDatabase(':memory:'));
  });

  afterEach(() => {
    closeDatabase();
  });

  it('creates a new character -> Discord mapping', () => {
    const created = linkCharacterIdentity('Testcharacter', 'discord-1');

    expect(created).toBe(true);
    expect(getMapping('Testcharacter')?.discord_user_id).toBe('discord-1');
  });

  it('is idempotent when the same character maps to the same user', () => {
    expect(linkCharacterIdentity('Testcharacter', 'discord-1')).toBe(true);
    expect(linkCharacterIdentity('Testcharacter', 'discord-1')).toBe(false);

    const rows = getDatabase()
      .prepare('SELECT COUNT(*) AS c FROM raider_identity_map')
      .get() as { c: number };
    expect(rows.c).toBe(1);
  });

  it('does not overwrite an existing mapping to a different user', () => {
    linkCharacterIdentity('Testcharacter', 'discord-1');

    const created = linkCharacterIdentity('Testcharacter', 'discord-2');

    expect(created).toBe(false);
    expect(getMapping('Testcharacter')?.discord_user_id).toBe('discord-1');
  });

  it('treats character names case-insensitively', () => {
    linkCharacterIdentity('Testcharacter', 'discord-1');

    const created = linkCharacterIdentity('testcharacter', 'discord-2');

    expect(created).toBe(false);
    const rows = getDatabase()
      .prepare('SELECT COUNT(*) AS c FROM raider_identity_map')
      .get() as { c: number };
    expect(rows.c).toBe(1);
  });
});

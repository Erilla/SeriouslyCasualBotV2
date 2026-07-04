import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Guild, GuildMember, User } from 'discord.js';
import { initDatabase, closeDatabase, getDatabase } from '../../src/database/db.js';
import type { RaiderRow } from '../../src/types/index.js';

vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { autoMatchRaiders } from '../../src/functions/raids/autoMatchRaiders.js';
import { logger } from '../../src/services/logger.js';

function createMockMember(
  displayName: string,
  globalDisplayName: string,
  username: string,
  id = '123456789',
  opts: { bot?: boolean; roleIds?: string[] } = {},
): GuildMember {
  const roleIds = new Set(opts.roleIds ?? []);
  return {
    displayName,
    id,
    user: {
      displayName: globalDisplayName,
      username,
      id,
      bot: opts.bot ?? false,
    } as User,
    roles: { cache: { has: (roleId: string) => roleIds.has(roleId) } },
  } as unknown as GuildMember;
}

function createMockGuild(members: GuildMember[]): Guild {
  const membersMap = new Map(members.map((m, i) => [String(i), m]));
  return {
    members: {
      fetch: vi.fn().mockResolvedValue(membersMap),
    },
  } as unknown as Guild;
}

function createRaider(characterName: string): RaiderRow {
  return {
    id: 1,
    character_name: characterName,
    realm: 'silvermoon',
    region: 'eu',
    rank: null,
    class: null,
    discord_user_id: null,
    message_id: null,
    missing_since: null,
  };
}

function insertRaider(name: string, discordUserId: string | null = null) {
  getDatabase()
    .prepare('INSERT INTO raiders (character_name, discord_user_id) VALUES (?, ?)')
    .run(name, discordUserId);
}

function setRaiderRole(roleId: string) {
  getDatabase()
    .prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)')
    .run('raider_role_id', roleId);
}

beforeEach(() => {
  closeDatabase();
  initDatabase(':memory:');
  vi.clearAllMocks();
});

afterEach(() => {
  closeDatabase();
});

describe('autoMatchRaiders', () => {
  it('should match on exact displayName', async () => {
    const member = createMockMember('Thrall', 'SomeGlobal', 'someuser');
    const guild = createMockGuild([member]);
    const raider = createRaider('Thrall');

    const result = await autoMatchRaiders(guild, [raider]);

    expect(result).toHaveLength(1);
    expect(result[0].raider.character_name).toBe('Thrall');
    expect(result[0].suggestedUser).toBe(member);
  });

  it('should match case-insensitively', async () => {
    const member = createMockMember('THRALL', 'SomeGlobal', 'someuser');
    const guild = createMockGuild([member]);
    const raider = createRaider('thrall');

    const result = await autoMatchRaiders(guild, [raider]);

    expect(result).toHaveLength(1);
    expect(result[0].suggestedUser).toBe(member);
  });

  it('should return empty when no match found', async () => {
    const member = createMockMember('Jaina', 'JainaGlobal', 'jainauser');
    const guild = createMockGuild([member]);
    const raider = createRaider('Thrall');

    const result = await autoMatchRaiders(guild, [raider]);

    expect(result).toHaveLength(0);
  });

  it('should skip ambiguous matches (multiple members match same name)', async () => {
    const member1 = createMockMember('Thrall', 'SomeGlobal1', 'user1', '111');
    const member2 = createMockMember('Thrall', 'SomeGlobal2', 'user2', '222');
    const guild = createMockGuild([member1, member2]);
    const raider = createRaider('Thrall');

    const result = await autoMatchRaiders(guild, [raider]);

    expect(result).toHaveLength(0);
  });

  it('should return empty for empty unlinked raiders array', async () => {
    const guild = createMockGuild([]);

    const result = await autoMatchRaiders(guild, []);

    expect(result).toHaveLength(0);
  });

  it('should match on user.displayName (global display name)', async () => {
    const member = createMockMember('ServerNick', 'Thrall', 'someuser');
    const guild = createMockGuild([member]);
    const raider = createRaider('Thrall');

    const result = await autoMatchRaiders(guild, [raider]);

    expect(result).toHaveLength(1);
    expect(result[0].suggestedUser).toBe(member);
  });

  it('should match on user.username', async () => {
    const member = createMockMember('ServerNick', 'SomeGlobal', 'thrall');
    const guild = createMockGuild([member]);
    const raider = createRaider('Thrall');

    const result = await autoMatchRaiders(guild, [raider]);

    expect(result).toHaveLength(1);
    expect(result[0].suggestedUser).toBe(member);
  });

  // ── New behaviour ──────────────────────────────────────────

  it('excludes a Discord user already linked to another raider', async () => {
    const member = createMockMember('Thrall', 'g', 'u', '999');
    const guild = createMockGuild([member]);
    insertRaider('Grommash', '999'); // user 999 already linked elsewhere
    const raider = createRaider('Thrall'); // name matches member 999

    const result = await autoMatchRaiders(guild, [raider]);

    expect(result).toHaveLength(0);
  });

  it('suggests the only non-already-linked name match', async () => {
    const linked = createMockMember('Thrall', 'g1', 'u1', '111');
    const free = createMockMember('Thrall', 'g2', 'u2', '222');
    const guild = createMockGuild([linked, free]);
    insertRaider('Grommash', '111'); // 111 already linked
    const raider = createRaider('Thrall');

    const result = await autoMatchRaiders(guild, [raider]);

    expect(result).toHaveLength(1);
    expect(result[0].suggestedUser.id).toBe('222');
  });

  it('never suggests a bot even on a name match', async () => {
    const bot = createMockMember('Thrall', 'g', 'u', '777', { bot: true });
    const guild = createMockGuild([bot]);
    const raider = createRaider('Thrall');

    const result = await autoMatchRaiders(guild, [raider]);

    expect(result).toHaveLength(0);
  });

  it('matches through accents, realm suffix, and decoration', async () => {
    const member = createMockMember('✨Hephaestüs-Silvermoon✨', 'g', 'u', '555');
    const guild = createMockGuild([member]);
    const raider = createRaider('Hephaestus');

    const result = await autoMatchRaiders(guild, [raider]);

    expect(result).toHaveLength(1);
    expect(result[0].suggestedUser.id).toBe('555');
  });

  it('elimination: sole unlinked raider + sole unlinked Raider-role member is suggested', async () => {
    const roleId = 'raider-role';
    const member = createMockMember('SomeoneElse', 'g', 'u', '333', { roleIds: [roleId] });
    const guild = createMockGuild([member]);
    setRaiderRole(roleId);
    insertRaider('Shadowleif', null); // the sole unlinked raider in the DB
    const raider = createRaider('Shadowleif'); // name does NOT match 'SomeoneElse'

    const result = await autoMatchRaiders(guild, [raider]);

    expect(result).toHaveLength(1);
    expect(result[0].suggestedUser.id).toBe('333');
    expect(logger.info).toHaveBeenCalledWith(
      'AutoMatch',
      expect.stringContaining('elimination match'),
    );
  });

  it('elimination suppressed when more than one unlinked raider exists', async () => {
    const roleId = 'raider-role';
    const member = createMockMember('SomeoneElse', 'g', 'u', '333', { roleIds: [roleId] });
    const guild = createMockGuild([member]);
    setRaiderRole(roleId);
    insertRaider('Shadowleif', null);
    insertRaider('Otherguy', null); // now 2 unlinked raiders
    const raider = createRaider('Shadowleif');

    const result = await autoMatchRaiders(guild, [raider]);

    expect(result).toHaveLength(0);
  });

  it('elimination suppressed when more than one unlinked Raider-role member exists', async () => {
    const roleId = 'raider-role';
    const m1 = createMockMember('A', 'g', 'u', '333', { roleIds: [roleId] });
    const m2 = createMockMember('B', 'g', 'u', '444', { roleIds: [roleId] });
    const guild = createMockGuild([m1, m2]);
    setRaiderRole(roleId);
    insertRaider('Shadowleif', null);
    const raider = createRaider('Shadowleif');

    const result = await autoMatchRaiders(guild, [raider]);

    expect(result).toHaveLength(0);
  });

  it('elimination suppressed when raider_role_id is not configured', async () => {
    const member = createMockMember('SomeoneElse', 'g', 'u', '333', { roleIds: ['raider-role'] });
    const guild = createMockGuild([member]);
    insertRaider('Shadowleif', null); // 1 unlinked, but no role configured
    const raider = createRaider('Shadowleif');

    const result = await autoMatchRaiders(guild, [raider]);

    expect(result).toHaveLength(0);
  });

  it('elimination does not count a bot toward the eligible member', async () => {
    const roleId = 'raider-role';
    const human = createMockMember('SomeoneElse', 'g', 'u', '333', { roleIds: [roleId] });
    const bot = createMockMember('BotUser', 'g', 'u', '888', { roleIds: [roleId], bot: true });
    const guild = createMockGuild([human, bot]);
    setRaiderRole(roleId);
    insertRaider('Shadowleif', null);
    const raider = createRaider('Shadowleif');

    const result = await autoMatchRaiders(guild, [raider]);

    expect(result).toHaveLength(1);
    expect(result[0].suggestedUser.id).toBe('333');
  });
});

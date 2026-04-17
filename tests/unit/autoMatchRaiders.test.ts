import { describe, it, expect, vi } from 'vitest';
import { autoMatchRaiders } from '../../src/functions/raids/autoMatchRaiders.js';
import type { RaiderRow } from '../../src/types/index.js';
import type { Guild, GuildMember, Collection, User } from 'discord.js';

function createMockMember(
  displayName: string,
  globalDisplayName: string,
  username: string,
  id = '123456789',
): GuildMember {
  return {
    displayName,
    id,
    user: {
      displayName: globalDisplayName,
      username,
      id,
    } as User,
  } as GuildMember;
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
    expect(result[0].raider.character_name).toBe('thrall');
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
});

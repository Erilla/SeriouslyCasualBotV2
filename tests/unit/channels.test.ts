import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ChannelType } from 'discord.js';
import type { Guild } from 'discord.js';
import { createTables } from '../../src/database/schema.js';
import { getDatabase, closeDatabase } from '../../src/database/db.js';
import { getCategoryByName } from '../../src/functions/channels.js';

type MockChannel = {
  id: string;
  name: string;
  type: ChannelType;
  parentId: string | null;
};

function mkChannel(partial: Partial<MockChannel> & { id: string; name: string; type: ChannelType }): MockChannel {
  return { parentId: null, ...partial };
}

function mkGuild(channels: MockChannel[] = []): Guild {
  const map = new Map<string, MockChannel>(channels.map((c) => [c.id, c]));
  const cache = {
    get: (id: string) => map.get(id),
    find: (predicate: (c: MockChannel) => boolean) => {
      for (const c of map.values()) if (predicate(c)) return c;
      return undefined;
    },
    filter: (predicate: (c: MockChannel) => boolean) => {
      const out: MockChannel[] = [];
      for (const c of map.values()) if (predicate(c)) out.push(c);
      return out;
    },
    values: () => map.values(),
  };
  return {
    id: 'guild-1',
    channels: {
      cache,
      fetch: vi.fn(async (id: string) => map.get(id) ?? null),
      create: vi.fn(async (opts: { name: string; type: ChannelType; parent?: string | null }) => {
        const created: MockChannel = {
          id: `created-${opts.name}`,
          name: opts.name,
          type: opts.type,
          parentId: opts.parent ?? null,
        };
        map.set(created.id, created);
        return created;
      }),
    },
  } as unknown as Guild;
}

beforeEach(() => {
  closeDatabase();
  const db = getDatabase(':memory:');
  createTables(db);
});

afterEach(() => {
  closeDatabase();
});

describe('getCategoryByName', () => {
  it('finds a category by exact name', () => {
    const guild = mkGuild([
      mkChannel({ id: 'cat-1', name: 'Overlords', type: ChannelType.GuildCategory }),
      mkChannel({ id: 'cat-2', name: 'Raiders', type: ChannelType.GuildCategory }),
    ]);

    const found = getCategoryByName(guild, 'Overlords');

    expect(found?.id).toBe('cat-1');
  });

  it('returns null when no category with that name exists', () => {
    const guild = mkGuild([
      mkChannel({ id: 'cat-1', name: 'Overlords', type: ChannelType.GuildCategory }),
    ]);

    const found = getCategoryByName(guild, 'DoesNotExist');

    expect(found).toBeNull();
  });

  it('matches case-insensitively', () => {
    const guild = mkGuild([
      mkChannel({ id: 'cat-1', name: 'Overlords', type: ChannelType.GuildCategory }),
    ]);

    const found = getCategoryByName(guild, 'overlords');

    expect(found?.id).toBe('cat-1');
  });

  it('ignores non-category channels with the same name', () => {
    const guild = mkGuild([
      mkChannel({ id: 'ch-1', name: 'Overlords', type: ChannelType.GuildText }),
    ]);

    const found = getCategoryByName(guild, 'Overlords');

    expect(found).toBeNull();
  });
});

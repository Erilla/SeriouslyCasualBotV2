import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ChannelType } from 'discord.js';
import type { Guild } from 'discord.js';
import { createTables } from '../../src/database/schema.js';
import { getDatabase, closeDatabase } from '../../src/database/db.js';
import { getCategoryByName, getOrCreateChannel } from '../../src/functions/channels.js';
import { logger } from '../../src/services/logger.js';

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
    // Expose set so tests can inject channels after construction (cold-cache tests).
    set: (id: string, ch: MockChannel) => map.set(id, ch),
  };
  return {
    id: 'guild-1',
    channels: {
      cache,
      fetch: vi.fn(async (id?: string) => {
        if (id === undefined) return cache; // parameterless refresh: return the collection
        return map.get(id) ?? null;
      }),
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

function setConfig(key: string, value: string): void {
  getDatabase().prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, value);
}

function getConfig(key: string): string | undefined {
  const row = getDatabase().prepare('SELECT value FROM config WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

describe('getOrCreateChannel — config-ID path', () => {
  it('returns the channel referenced by the stored config ID when it exists with correct type', async () => {
    const guild = mkGuild([
      mkChannel({ id: 'ch-existing', name: 'trial-reviews', type: ChannelType.GuildForum }),
    ]);
    setConfig('trial_reviews_forum_id', 'ch-existing');

    const result = await getOrCreateChannel(guild, {
      name: 'trial-reviews',
      type: ChannelType.GuildForum,
      categoryName: 'Overlords',
      configKey: 'trial_reviews_forum_id',
    });

    expect(result.id).toBe('ch-existing');
    expect(guild.channels.create).not.toHaveBeenCalled();
  });

  it('ignores the stored ID when the channel has been deleted and falls through', async () => {
    const guild = mkGuild([]);
    setConfig('trial_reviews_forum_id', 'ch-gone');

    const result = await getOrCreateChannel(guild, {
      name: 'trial-reviews',
      type: ChannelType.GuildForum,
      categoryName: 'Overlords',
      configKey: 'trial_reviews_forum_id',
    });

    // Will create — no name match, no category, so parent-less create
    expect(result.name).toBe('trial-reviews');
    expect(guild.channels.create).toHaveBeenCalledTimes(1);
  });
});

describe('getOrCreateChannel — name lookup', () => {
  it('reuses an existing channel found by name when config is empty', async () => {
    const guild = mkGuild([
      mkChannel({ id: 'cat-1', name: 'Overlords', type: ChannelType.GuildCategory }),
      mkChannel({ id: 'ch-by-name', name: 'trial-reviews', type: ChannelType.GuildForum, parentId: 'cat-1' }),
    ]);

    const result = await getOrCreateChannel(guild, {
      name: 'trial-reviews',
      type: ChannelType.GuildForum,
      categoryName: 'Overlords',
      configKey: 'trial_reviews_forum_id',
    });

    expect(result.id).toBe('ch-by-name');
    expect(guild.channels.create).not.toHaveBeenCalled();
    expect(getConfig('trial_reviews_forum_id')).toBe('ch-by-name');
  });

  it('is case-insensitive on the channel name', async () => {
    const guild = mkGuild([
      mkChannel({ id: 'ch-1', name: 'Trial-Reviews', type: ChannelType.GuildForum }),
    ]);

    const result = await getOrCreateChannel(guild, {
      name: 'trial-reviews',
      type: ChannelType.GuildForum,
      categoryName: null,
      configKey: 'trial_reviews_forum_id',
    });

    expect(result.id).toBe('ch-1');
  });

  it('accepts alias names for the name lookup', async () => {
    const guild = mkGuild([
      mkChannel({ id: 'ch-welcome', name: 'welcome', type: ChannelType.GuildText }),
    ]);

    const result = await getOrCreateChannel(guild, {
      name: 'guild-info',
      type: ChannelType.GuildText,
      categoryName: null,
      configKey: 'guild_info_channel_id',
      aliasNames: ['welcome'],
    });

    expect(result.id).toBe('ch-welcome');
  });

  it('prefers primary name over alias when both exist as correctly-typed channels', async () => {
    // guild-info (primary) AND welcome (alias) both exist with correct type.
    // Should resolve to guild-info, not welcome.
    const guild = mkGuild([
      mkChannel({ id: 'ch-guild-info', name: 'guild-info', type: ChannelType.GuildText }),
      mkChannel({ id: 'ch-welcome', name: 'welcome', type: ChannelType.GuildText }),
    ]);

    const result = await getOrCreateChannel(guild, {
      name: 'guild-info',
      type: ChannelType.GuildText,
      categoryName: null,
      configKey: 'guild_info_channel_id',
      aliasNames: ['welcome'],
    });

    expect(result.id).toBe('ch-guild-info');
    expect(guild.channels.create).not.toHaveBeenCalled();
  });

  it('falls through to alias when primary name has no correctly-typed match but alias does', async () => {
    // guild-info exists but as GuildForum (wrong type); welcome exists as GuildText (correct).
    // Should resolve to welcome, not create a new channel.
    const guild = mkGuild([
      mkChannel({ id: 'ch-guild-info-wrong', name: 'guild-info', type: ChannelType.GuildForum }),
      mkChannel({ id: 'ch-welcome', name: 'welcome', type: ChannelType.GuildText }),
    ]);

    const result = await getOrCreateChannel(guild, {
      name: 'guild-info',
      type: ChannelType.GuildText,
      categoryName: null,
      configKey: 'guild_info_channel_id',
      aliasNames: ['welcome'],
    });

    expect(result.id).toBe('ch-welcome');
    expect(guild.channels.create).not.toHaveBeenCalled();
  });

  it('warns and picks the first when duplicates exist', async () => {
    const guild = mkGuild([
      mkChannel({ id: 'ch-1', name: 'raiders-lounge', type: ChannelType.GuildText }),
      mkChannel({ id: 'ch-2', name: 'raiders-lounge', type: ChannelType.GuildText }),
    ]);

    const result = await getOrCreateChannel(guild, {
      name: 'raiders-lounge',
      type: ChannelType.GuildText,
      categoryName: null,
      configKey: 'raiders_lounge_channel_id',
    });

    expect(result.id).toBe('ch-1');
  });

  it('treats a wrong-typed name match as a miss and creates a new channel', async () => {
    const guild = mkGuild([
      mkChannel({ id: 'ch-wrong', name: 'trial-reviews', type: ChannelType.GuildText }),
    ]);

    const result = await getOrCreateChannel(guild, {
      name: 'trial-reviews',
      type: ChannelType.GuildForum,
      categoryName: null,
      configKey: 'trial_reviews_forum_id',
    });

    expect(result.id).not.toBe('ch-wrong');
    expect(result.type).toBe(ChannelType.GuildForum);
    expect(guild.channels.create).toHaveBeenCalledTimes(1);
  });

  it('reuses an existing category by name when resolving a category-type channel', async () => {
    const guild = mkGuild([
      mkChannel({ id: 'cat-apps', name: 'Applications', type: ChannelType.GuildCategory }),
    ]);

    const result = await getOrCreateChannel(guild, {
      name: 'Applications',
      type: ChannelType.GuildCategory,
      categoryName: null,
      configKey: 'applications_category_id',
    });

    expect(result.id).toBe('cat-apps');
    expect(guild.channels.create).not.toHaveBeenCalled();
    expect(getConfig('applications_category_id')).toBe('cat-apps');
  });

  it('warns about wrong-typed primary-name match even when alias has a correct match', async () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    const guild = mkGuild([
      mkChannel({ id: 'ch-wrong-primary', name: 'guild-info', type: ChannelType.GuildForum }),
      mkChannel({ id: 'ch-welcome', name: 'welcome', type: ChannelType.GuildText }),
    ]);

    const result = await getOrCreateChannel(guild, {
      name: 'guild-info',
      type: ChannelType.GuildText,
      categoryName: null,
      configKey: 'guild_info_channel_id',
      aliasNames: ['welcome'],
    });

    expect(result.id).toBe('ch-welcome');
    expect(warnSpy).toHaveBeenCalledWith(
      'channels',
      expect.stringContaining('wrong type'),
    );
    warnSpy.mockRestore();
  });
});

describe('getOrCreateChannel — create path', () => {
  it('creates under the resolved category when one is named', async () => {
    const guild = mkGuild([
      mkChannel({ id: 'cat-overlords', name: 'Overlords', type: ChannelType.GuildCategory }),
    ]);

    const result = await getOrCreateChannel(guild, {
      name: 'trial-reviews',
      type: ChannelType.GuildForum,
      categoryName: 'Overlords',
      configKey: 'trial_reviews_forum_id',
    });

    expect(guild.channels.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'trial-reviews', parent: 'cat-overlords' }),
    );
    expect(result.parentId).toBe('cat-overlords');
  });

  it('creates without a parent when the category is missing', async () => {
    const guild = mkGuild([]);

    const result = await getOrCreateChannel(guild, {
      name: 'trial-reviews',
      type: ChannelType.GuildForum,
      categoryName: 'Overlords',
      configKey: 'trial_reviews_forum_id',
    });

    expect(guild.channels.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'trial-reviews', parent: undefined }),
    );
    expect(result.parentId).toBeNull();
  });

  it('creates without a parent when categoryName is null', async () => {
    const guild = mkGuild([
      mkChannel({ id: 'cat-overlords', name: 'Overlords', type: ChannelType.GuildCategory }),
    ]);

    await getOrCreateChannel(guild, {
      name: 'Applications',
      type: ChannelType.GuildCategory,
      categoryName: null,
      configKey: 'applications_category_id',
    });

    expect(guild.channels.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Applications', parent: undefined }),
    );
  });

  it('stores the new ID in config', async () => {
    const guild = mkGuild([]);

    await getOrCreateChannel(guild, {
      name: 'loot',
      type: ChannelType.GuildText,
      categoryName: null,
      configKey: 'loot_channel_id',
    });

    expect(getConfig('loot_channel_id')).toBe('created-loot');
  });

  it('passes through createOptions', async () => {
    const guild = mkGuild([]);

    await getOrCreateChannel(guild, {
      name: 'raiders-lounge',
      type: ChannelType.GuildText,
      categoryName: null,
      configKey: 'raiders_lounge_channel_id',
      createOptions: { topic: 'Raider signup alerts and discussion' },
    });

    expect(guild.channels.create).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'Raider signup alerts and discussion' }),
    );
  });

  it('does not pass parent when creating a GuildCategory channel', async () => {
    // Even if a parent category were somehow resolved, categories cannot have
    // parents in Discord. The guard must pass parent: undefined for GuildCategory.
    const guild = mkGuild([]);

    await getOrCreateChannel(guild, {
      name: 'My Category',
      type: ChannelType.GuildCategory,
      categoryName: null,
      configKey: 'my_category_id',
    });

    expect(guild.channels.create).toHaveBeenCalledWith(
      expect.objectContaining({ parent: undefined }),
    );
  });
});

describe('getOrCreateChannel — cold cache refresh', () => {
  it('refreshes the cache and reuses when name lookup was cold', async () => {
    const guild = mkGuild([]);

    // Simulate a cold cache: the channel exists on Discord but isn't populated
    // in the local cache yet. The parameterless fetch() call should add it.
    const coldChannel = mkChannel({
      id: 'ch-cold',
      name: 'trial-reviews',
      type: ChannelType.GuildForum,
    });

    const cacheRef = guild.channels.cache as unknown as { set: (k: string, v: MockChannel) => void };
    (guild.channels.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (id?: string) => {
      if (id === undefined) {
        cacheRef.set('ch-cold', coldChannel);
        return null;
      }
      return null;
    });

    const result = await getOrCreateChannel(guild, {
      name: 'trial-reviews',
      type: ChannelType.GuildForum,
      categoryName: null,
      configKey: 'trial_reviews_forum_id',
    });

    expect(result.id).toBe('ch-cold');
    expect(guild.channels.create).not.toHaveBeenCalled();
  });
});

describe('getOrCreateChannel — concurrent dedup', () => {
  it('deduplicates concurrent calls for the same configKey', async () => {
    const guild = mkGuild([]);

    const [a, b] = await Promise.all([
      getOrCreateChannel(guild, {
        name: 'concurrent-test',
        type: ChannelType.GuildText,
        categoryName: null,
        configKey: 'concurrent_test_channel_id',
      }),
      getOrCreateChannel(guild, {
        name: 'concurrent-test',
        type: ChannelType.GuildText,
        categoryName: null,
        configKey: 'concurrent_test_channel_id',
      }),
    ]);

    expect(a.id).toBe(b.id);
    expect(guild.channels.create).toHaveBeenCalledTimes(1);
  });

  it('does not share inflight dedup across guilds', async () => {
    const guildA = mkGuild([]);
    const guildB = { ...mkGuild([]), id: 'guild-2' } as unknown as Guild;
    // Give guildB its own channels mock so it doesn't share state with guildA.
    const mapB = new Map<string, MockChannel>();
    (guildB as unknown as { channels: ReturnType<typeof mkGuild>['channels'] }).channels = {
      cache: {
        get: (id: string) => mapB.get(id),
        find: (predicate: (c: MockChannel) => boolean) => {
          for (const c of mapB.values()) if (predicate(c)) return c;
          return undefined;
        },
        filter: (predicate: (c: MockChannel) => boolean) => {
          const out: MockChannel[] = [];
          for (const c of mapB.values()) if (predicate(c)) out.push(c);
          return out;
        },
        values: () => mapB.values(),
        set: (id: string, ch: MockChannel) => mapB.set(id, ch),
      } as unknown as Guild['channels']['cache'],
      fetch: vi.fn(async (id?: string) => {
        if (id === undefined) return mapB;
        return mapB.get(id) ?? null;
      }) as unknown as Guild['channels']['fetch'],
      create: vi.fn(async (opts: { name: string; type: ChannelType; parent?: string | null }) => {
        const created: MockChannel = {
          id: `created-guildB-${opts.name}`,
          name: opts.name,
          type: opts.type,
          parentId: opts.parent ?? null,
        };
        mapB.set(created.id, created);
        return created;
      }) as unknown as Guild['channels']['create'],
    };

    const [a, b] = await Promise.all([
      getOrCreateChannel(guildA, {
        name: 'channel-a',
        type: ChannelType.GuildText,
        categoryName: null,
        configKey: 'shared_key',
      }),
      getOrCreateChannel(guildB as unknown as Guild, {
        name: 'channel-b',
        type: ChannelType.GuildText,
        categoryName: null,
        configKey: 'shared_key',
      }),
    ]);

    expect(a.id).not.toBe(b.id);
    expect(guildA.channels.create).toHaveBeenCalledTimes(1);
    expect(guildB.channels.create).toHaveBeenCalledTimes(1);
  });
});

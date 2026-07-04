import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Client, Guild } from 'discord.js';
import { initDatabase, closeDatabase, getDatabase } from '../../src/database/db.js';

vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/config.js', () => ({
  config: { guildId: 'guild-123' },
}));

vi.mock('../../src/functions/channels.js', () => ({
  getOrCreateChannel: vi.fn(),
}));

import { refreshLinkingMessages } from '../../src/functions/raids/refreshLinkingMessages.js';
import { getOrCreateChannel } from '../../src/functions/channels.js';

const mockedGetOrCreateChannel = vi.mocked(getOrCreateChannel);

interface FakeMessage {
  id: string;
  pinned: boolean;
  deleted: boolean;
}

// A stateful channel stub.
// - fetch(stringId): resolves with the live message, or throws (Unknown Message).
// - fetch({ limit, before }): returns a Map of live messages, newest-first.
// - send(): appends a new live message and returns its id.
function makeChannel(initial: Array<{ id: string; pinned?: boolean }> = []) {
  // store is newest-first
  const store: FakeMessage[] = initial.map((m) => ({
    id: m.id,
    pinned: m.pinned ?? false,
    deleted: false,
  }));
  let n = 0;

  const wrap = (m: FakeMessage) => ({
    id: m.id,
    pinned: m.pinned,
    delete: vi.fn(async () => {
      m.deleted = true;
    }),
  });

  const channel = {
    messages: {
      fetch: vi.fn(async (arg: unknown) => {
        if (typeof arg === 'string') {
          const m = store.find((x) => x.id === arg && !x.deleted);
          if (!m) throw new Error('Unknown Message');
          return wrap(m);
        }
        const live = store.filter((x) => !x.deleted);
        return new Map(live.map((m) => [m.id, wrap(m)]));
      }),
    },
    // Mirrors discord.js TextChannel.bulkDelete: accepts an array of messages
    // (or ids), deletes them in one call, returns a Collection of the deleted.
    bulkDelete: vi.fn(async (msgs: Array<{ id: string } | string>) => {
      const ids = [...msgs].map((m) => (typeof m === 'string' ? m : m.id));
      const deleted: string[] = [];
      for (const id of ids) {
        const m = store.find((x) => x.id === id && !x.deleted);
        if (m) {
          m.deleted = true;
          deleted.push(id);
        }
      }
      return new Map(deleted.map((id) => [id, {}]));
    }),
    send: vi.fn(async () => {
      const m: FakeMessage = { id: `new-${++n}`, pinned: false, deleted: false };
      store.unshift(m);
      return { id: m.id };
    }),
    liveIds: () => store.filter((x) => !x.deleted).map((x) => x.id),
  };
  return channel;
}

function makeClient(guild: Guild) {
  return {
    guilds: { cache: { get: vi.fn().mockReturnValue(guild) }, fetch: vi.fn() },
  } as unknown as Client;
}

function seedConfig() {
  getDatabase()
    .prepare('INSERT INTO config (key, value) VALUES (?, ?)')
    .run('raider_setup_channel_id', 'chan-1');
}

function insertRaider(opts: {
  name: string;
  messageId?: string | null;
  discordUserId?: string | null;
  missingSince?: string | null;
}) {
  getDatabase()
    .prepare(
      `INSERT INTO raiders (character_name, realm, region, message_id, discord_user_id, missing_since)
       VALUES (?, 'silvermoon', 'eu', ?, ?, ?)`,
    )
    .run(opts.name, opts.messageId ?? null, opts.discordUserId ?? null, opts.missingSince ?? null);
}

function getMessageId(name: string): string | null {
  return (
    getDatabase()
      .prepare('SELECT message_id FROM raiders WHERE character_name = ?')
      .get(name) as { message_id: string | null }
  ).message_id;
}

beforeEach(() => {
  closeDatabase();
  initDatabase(':memory:');
  vi.clearAllMocks();
  seedConfig();
});

afterEach(() => {
  closeDatabase();
});

describe('refreshLinkingMessages', () => {
  it('posts a fresh alert for an unlinked raider that has no message_id (backlog)', async () => {
    insertRaider({ name: 'Backlog', messageId: null });
    const channel = makeChannel([]);
    mockedGetOrCreateChannel.mockResolvedValue(channel as never);

    await refreshLinkingMessages(makeClient({} as Guild));

    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(getMessageId('Backlog')).toBe('new-1');
  });

  it('reposts when the stored message_id no longer exists in the channel', async () => {
    insertRaider({ name: 'Lost', messageId: 'gone-123' });
    const channel = makeChannel([]); // 'gone-123' is not present
    mockedGetOrCreateChannel.mockResolvedValue(channel as never);

    await refreshLinkingMessages(makeClient({} as Guild));

    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(getMessageId('Lost')).toBe('new-1');
  });

  it('leaves the post alone when its message still exists (no reposition)', async () => {
    insertRaider({ name: 'Live', messageId: 'live-1' });
    const channel = makeChannel([{ id: 'live-1' }]);
    mockedGetOrCreateChannel.mockResolvedValue(channel as never);

    await refreshLinkingMessages(makeClient({} as Guild));

    expect(channel.send).not.toHaveBeenCalled();
    expect(getMessageId('Live')).toBe('live-1');
    expect(channel.liveIds()).toEqual(['live-1']);
  });

  it('does not post for raiders that have left the roster (missing_since set)', async () => {
    insertRaider({ name: 'Gone', messageId: null, missingSince: new Date().toISOString() });
    const channel = makeChannel([]);
    mockedGetOrCreateChannel.mockResolvedValue(channel as never);

    await refreshLinkingMessages(makeClient({} as Guild));

    expect(channel.send).not.toHaveBeenCalled();
  });

  it('does not post for already-linked raiders', async () => {
    insertRaider({ name: 'Linked', messageId: null, discordUserId: '123' });
    const channel = makeChannel([]);
    mockedGetOrCreateChannel.mockResolvedValue(channel as never);

    await refreshLinkingMessages(makeClient({} as Guild));

    expect(channel.send).not.toHaveBeenCalled();
  });

  it('sweeps an orphan message that is not tied to an awaiting raider', async () => {
    insertRaider({ name: 'Live', messageId: 'live-1' });
    const channel = makeChannel([{ id: 'live-1' }, { id: 'orphan-1' }]);
    mockedGetOrCreateChannel.mockResolvedValue(channel as never);

    await refreshLinkingMessages(makeClient({} as Guild));

    expect(channel.liveIds()).toEqual(['live-1']);
  });

  it('does not sweep pinned messages', async () => {
    const channel = makeChannel([{ id: 'pin-1', pinned: true }, { id: 'orphan-1' }]);
    mockedGetOrCreateChannel.mockResolvedValue(channel as never);

    await refreshLinkingMessages(makeClient({} as Guild));

    expect(channel.liveIds()).toEqual(['pin-1']);
  });

  it('keeps a freshly reposted message while sweeping orphans', async () => {
    insertRaider({ name: 'Lost', messageId: 'gone-1' });
    const channel = makeChannel([{ id: 'orphan-1' }]);
    mockedGetOrCreateChannel.mockResolvedValue(channel as never);

    await refreshLinkingMessages(makeClient({} as Guild));

    const live = channel.liveIds();
    expect(live).toContain('new-1');
    expect(live).not.toContain('orphan-1');
    expect(getMessageId('Lost')).toBe('new-1');
  });

  it('sweeps the leftover post of a raider who left the roster', async () => {
    insertRaider({ name: 'Gone', messageId: 'gone-post', missingSince: new Date().toISOString() });
    const channel = makeChannel([{ id: 'gone-post' }]);
    mockedGetOrCreateChannel.mockResolvedValue(channel as never);

    await refreshLinkingMessages(makeClient({} as Guild));

    expect(channel.send).not.toHaveBeenCalled();
    expect(channel.liveIds()).toEqual([]);
  });

  it('sweeps the channel even when there are no awaiting raiders', async () => {
    const channel = makeChannel([{ id: 'stale-1' }, { id: 'stale-2' }]);
    mockedGetOrCreateChannel.mockResolvedValue(channel as never);

    await refreshLinkingMessages(makeClient({} as Guild));

    expect(channel.liveIds()).toEqual([]);
  });

  it('sweeps stale messages with bulkDelete, not one-by-one', async () => {
    // A large backlog is what hung the old per-message delete loop. The sweep
    // must clear it in batched bulkDelete calls instead.
    const stale = Array.from({ length: 250 }, (_, i) => ({ id: `stale-${i}` }));
    const channel = makeChannel(stale);
    mockedGetOrCreateChannel.mockResolvedValue(channel as never);

    await refreshLinkingMessages(makeClient({} as Guild));

    expect(channel.bulkDelete).toHaveBeenCalled();
    // 250 stale across 100-per-page fetches => a handful of calls, not 250.
    expect(channel.bulkDelete.mock.calls.length).toBeLessThanOrEqual(5);
    expect(channel.liveIds()).toEqual([]);
  });

  it('keeps awaiting-raider posts while bulk-sweeping the rest', async () => {
    insertRaider({ name: 'Live', messageId: 'live-1' });
    const channel = makeChannel([
      { id: 'live-1' },
      { id: 'orphan-1' },
      { id: 'orphan-2' },
    ]);
    mockedGetOrCreateChannel.mockResolvedValue(channel as never);

    await refreshLinkingMessages(makeClient({} as Guild));

    expect(channel.bulkDelete).toHaveBeenCalled();
    expect(channel.liveIds()).toEqual(['live-1']);
  });
});

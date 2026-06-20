import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Client, Guild, User } from 'discord.js';
import { initDatabase, closeDatabase, getDatabase } from '../../src/database/db.js';
import type { RaiderRow } from '../../src/types/index.js';
import type { AutoMatch } from '../../src/functions/raids/autoMatchRaiders.js';

vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/config.js', () => ({
  config: { guildId: 'guild-123' },
}));

vi.mock('../../src/functions/channels.js', () => ({
  getOrCreateChannel: vi.fn(),
}));

import { sendAlertForRaidersWithNoUser } from '../../src/functions/raids/sendAlertForRaidersWithNoUser.js';
import { getOrCreateChannel } from '../../src/functions/channels.js';

const mockedGetOrCreateChannel = vi.mocked(getOrCreateChannel);

interface FakeMessage {
  id: string;
  deleted: boolean;
}

// A stateful channel stub.
// - send(): appends a new live message and returns its id.
// - messages.delete(id): marks a message deleted (throws if already gone).
function makeChannel(initial: string[] = []) {
  const store: FakeMessage[] = initial.map((id) => ({ id, deleted: false }));
  let n = 0;

  const channel = {
    messages: {
      delete: vi.fn(async (id: string) => {
        const m = store.find((x) => x.id === id && !x.deleted);
        if (!m) throw new Error('Unknown Message');
        m.deleted = true;
      }),
    },
    send: vi.fn(async () => {
      const m: FakeMessage = { id: `new-${++n}`, deleted: false };
      store.unshift(m);
      return { id: m.id };
    }),
    liveIds: () => store.filter((x) => !x.deleted).map((x) => x.id),
  };
  return channel;
}

function makeClient(guild: Guild) {
  return {
    guilds: { fetch: vi.fn().mockResolvedValue(guild) },
  } as unknown as Client;
}

function insertRaider(name: string, messageId: string | null): RaiderRow {
  getDatabase()
    .prepare(
      `INSERT INTO raiders (character_name, realm, region, message_id, discord_user_id, missing_since)
       VALUES (?, 'silvermoon', 'eu', ?, NULL, NULL)`,
    )
    .run(name, messageId);
  return getDatabase()
    .prepare('SELECT * FROM raiders WHERE character_name = ?')
    .get(name) as RaiderRow;
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
  getDatabase()
    .prepare('INSERT INTO config (key, value) VALUES (?, ?)')
    .run('raider_setup_channel_id', 'chan-1');
});

afterEach(() => {
  closeDatabase();
});

describe('sendAlertForRaidersWithNoUser', () => {
  it('deletes the previous post when re-alerting an unmatched raider that already has a message_id', async () => {
    const raider = insertRaider('Backlog', 'old-1');
    const channel = makeChannel(['old-1']);
    mockedGetOrCreateChannel.mockResolvedValue(channel as never);

    await sendAlertForRaidersWithNoUser(makeClient({} as Guild), [raider], []);

    expect(channel.messages.delete).toHaveBeenCalledWith('old-1');
    expect(channel.liveIds()).toEqual(['new-1']); // old swept, only the fresh post remains
    expect(getMessageId('Backlog')).toBe('new-1');
  });

  it('does not attempt a delete when the raider has no previous message_id', async () => {
    const raider = insertRaider('Fresh', null);
    const channel = makeChannel([]);
    mockedGetOrCreateChannel.mockResolvedValue(channel as never);

    await sendAlertForRaidersWithNoUser(makeClient({} as Guild), [raider], []);

    expect(channel.messages.delete).not.toHaveBeenCalled();
    expect(channel.liveIds()).toEqual(['new-1']);
    expect(getMessageId('Fresh')).toBe('new-1');
  });

  it('deletes the previous post when re-alerting an auto-matched raider', async () => {
    const raider = insertRaider('Matched', 'old-2');
    const suggestedUser = { id: 'user-9', toString: () => '<@user-9>' } as unknown as User;
    const matches: AutoMatch[] = [{ raider, suggestedUser }];
    const channel = makeChannel(['old-2']);
    mockedGetOrCreateChannel.mockResolvedValue(channel as never);

    await sendAlertForRaidersWithNoUser(makeClient({} as Guild), [raider], matches);

    expect(channel.messages.delete).toHaveBeenCalledWith('old-2');
    expect(channel.liveIds()).toEqual(['new-1']);
    expect(getMessageId('Matched')).toBe('new-1');
  });

  it('still posts the new alert when the old message is already gone', async () => {
    const raider = insertRaider('Stale', 'gone-1');
    const channel = makeChannel([]); // 'gone-1' not present -> delete throws
    mockedGetOrCreateChannel.mockResolvedValue(channel as never);

    await sendAlertForRaidersWithNoUser(makeClient({} as Guild), [raider], []);

    expect(channel.liveIds()).toEqual(['new-1']);
    expect(getMessageId('Stale')).toBe('new-1');
  });
});

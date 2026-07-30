import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscordAPIError, RESTJSONErrorCodes, type Client } from 'discord.js';
import { closeDatabase, getDatabase, initDatabase } from '../../src/database/db.js';

vi.mock('../../src/functions/channels.js', () => ({
  getOrCreateChannel: vi.fn(),
}));

vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { getOrCreateChannel } from '../../src/functions/channels.js';
import { clearGuildInfo } from '../../src/functions/guild-info/clearGuildInfo.js';
import { upsertGuildInfoMessage } from '../../src/functions/guild-info/managedGuildInfoMessage.js';

const mockedGetOrCreateChannel = vi.mocked(getOrCreateChannel);

function unknownMessageError(): DiscordAPIError {
  return new DiscordAPIError(
    { code: RESTJSONErrorCodes.UnknownMessage, message: 'Unknown Message' },
    RESTJSONErrorCodes.UnknownMessage,
    404,
    'GET',
    '/channels/channel/messages/missing',
    { body: undefined, files: undefined },
  );
}

function makeChannel() {
  return {
    messages: {
      fetch: vi.fn(),
      delete: vi.fn(async () => undefined),
    },
    send: vi.fn(async () => ({ id: 'replacement' })),
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

describe('managed guild info messages', () => {
  it('edits the stored aboutus message instead of sending a replacement', async () => {
    const channel = makeChannel();
    const edit = vi.fn(async () => undefined);
    channel.messages.fetch.mockResolvedValue({ edit });
    getDatabase()
      .prepare('INSERT INTO guild_info_messages (key, message_id) VALUES (?, ?)')
      .run('aboutus', 'existing');

    await upsertGuildInfoMessage(channel as never, 'aboutus', { content: 'new' });

    expect(channel.messages.fetch).toHaveBeenCalledWith('existing');
    expect(edit).toHaveBeenCalledWith({ content: 'new' });
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('replaces a stored schedule message only when Discord reports it unknown', async () => {
    const channel = makeChannel();
    channel.messages.fetch.mockRejectedValue(unknownMessageError());
    getDatabase()
      .prepare('INSERT INTO guild_info_messages (key, message_id) VALUES (?, ?)')
      .run('schedule', 'missing');

    await upsertGuildInfoMessage(channel as never, 'schedule', { content: 'new' });

    expect(channel.send).toHaveBeenCalledWith({ content: 'new' });
    expect(
      getDatabase()
        .prepare('SELECT message_id FROM guild_info_messages WHERE key = ?')
        .get('schedule'),
    ).toEqual({ message_id: 'replacement' });
  });

  it('force-clears only the four tracked guild info messages', async () => {
    const channel = makeChannel();
    mockedGetOrCreateChannel.mockResolvedValue(channel as never);
    const db = getDatabase();
    for (const [key, id] of [
      ['aboutus', 'about-id'],
      ['schedule', 'schedule-id'],
      ['recruitment', 'recruitment-id'],
      ['achievements', 'achievements-id'],
      ['unrelated', 'unrelated-id'],
    ]) {
      db.prepare('INSERT INTO guild_info_messages (key, message_id) VALUES (?, ?)').run(key, id);
    }

    await clearGuildInfo({ guilds: { fetch: vi.fn() } } as unknown as Client);

    expect(channel.messages.delete).toHaveBeenCalledTimes(4);
    expect(channel.messages.delete).toHaveBeenCalledWith('about-id');
    expect(channel.messages.delete).toHaveBeenCalledWith('schedule-id');
    expect(channel.messages.delete).toHaveBeenCalledWith('recruitment-id');
    expect(channel.messages.delete).toHaveBeenCalledWith('achievements-id');
    expect(channel.messages.delete).not.toHaveBeenCalledWith('unrelated-id');
    expect(db.prepare('SELECT key FROM guild_info_messages ORDER BY key').all()).toEqual([
      { key: 'unrelated' },
    ]);
  });

  it('treats an unknown tracked message as already absent during force-clear', async () => {
    const channel = makeChannel();
    channel.messages.delete.mockRejectedValue(unknownMessageError());
    mockedGetOrCreateChannel.mockResolvedValue(channel as never);
    getDatabase()
      .prepare('INSERT INTO guild_info_messages (key, message_id) VALUES (?, ?)')
      .run('aboutus', 'missing');

    await clearGuildInfo({ guilds: { fetch: vi.fn() } } as unknown as Client);

    expect(
      getDatabase().prepare('SELECT * FROM guild_info_messages WHERE key = ?').get('aboutus'),
    ).toBeUndefined();
  });

  it('stops force-clear on a non-404 delete error without deleting later rows', async () => {
    const channel = makeChannel();
    const denied = new Error('Missing Permissions');
    channel.messages.delete.mockRejectedValueOnce(denied);
    mockedGetOrCreateChannel.mockResolvedValue(channel as never);
    const db = getDatabase();
    db.prepare('INSERT INTO guild_info_messages (key, message_id) VALUES (?, ?)').run(
      'aboutus',
      'first',
    );
    db.prepare('INSERT INTO guild_info_messages (key, message_id) VALUES (?, ?)').run(
      'schedule',
      'second',
    );

    await expect(
      clearGuildInfo({ guilds: { fetch: vi.fn() } } as unknown as Client),
    ).rejects.toThrow('Missing Permissions');

    expect(channel.messages.delete).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT key FROM guild_info_messages ORDER BY key').all()).toEqual([
      { key: 'aboutus' },
      { key: 'schedule' },
    ]);
  });
});

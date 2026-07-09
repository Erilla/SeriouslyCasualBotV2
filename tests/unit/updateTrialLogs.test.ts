import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Client, Guild } from 'discord.js';
import { initDatabase, closeDatabase, getDatabase } from '../../src/database/db.js';

vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/config.js', () => ({
  config: { guildId: 'guild-123' },
}));

vi.mock('../../src/functions/trial-review/generateTrialLogs.js', () => ({
  generateTrialLogsContent: vi.fn(),
}));

import { updateTrialLogs } from '../../src/functions/trial-review/updateTrialLogs.js';
import { generateTrialLogsContent } from '../../src/functions/trial-review/generateTrialLogs.js';
import { logger } from '../../src/services/logger.js';

const mockedGenerate = vi.mocked(generateTrialLogsContent);

// A thread stub whose message can be edited.
function makeThread() {
  const existingMsg = { edit: vi.fn().mockResolvedValue(undefined) };
  return {
    send: vi.fn().mockResolvedValue({ id: 'new-msg' }),
    messages: { fetch: vi.fn().mockResolvedValue(existingMsg) },
    _existingMsg: existingMsg,
  };
}

// A guild that owns the thread: channels.fetch resolves it.
function makeOwningGuild(id: string, thread: ReturnType<typeof makeThread>) {
  return {
    id,
    channels: { fetch: vi.fn().mockResolvedValue(thread) },
  } as unknown as Guild;
}

// A foreign guild that does NOT own the thread: channels.fetch throws,
// mirroring discord.js GuildChannelManager#fetch on a cross-guild id.
function makeForeignGuild(id: string) {
  return {
    id,
    channels: {
      fetch: vi
        .fn()
        .mockRejectedValue(
          new Error(
            "GuildChannelUnowned: The fetched channel does not belong to this manager's guild.",
          ),
        ),
    },
  } as unknown as Guild;
}

// Client is a member of TWO guilds. `cache.first()` returns the wrong
// (foreign) one; only `cache.get(config.guildId)` returns the owner.
function makeMultiGuildClient(owner: Guild, foreign: Guild) {
  const map = new Map<string, Guild>();
  // Insert foreign FIRST so that first() returns it (insertion order).
  map.set(foreign.id, foreign);
  map.set(owner.id, owner);
  return {
    guilds: {
      cache: {
        first: () => foreign,
        get: (id: string) => map.get(id),
      },
    },
  } as unknown as Client;
}

function insertActiveTrial(opts: { name: string; threadId: string; logsMessageId?: string }) {
  getDatabase()
    .prepare(
      `INSERT INTO trials (character_name, role, start_date, thread_id, logs_message_id, status)
       VALUES (?, 'dps', '2026-01-01', ?, ?, 'active')`,
    )
    .run(opts.name, opts.threadId, opts.logsMessageId ?? null);
}

beforeEach(() => {
  closeDatabase();
  initDatabase(':memory:');
  vi.clearAllMocks();
  mockedGenerate.mockResolvedValue('LOGS CONTENT');
});

afterEach(() => {
  closeDatabase();
});

describe('updateTrialLogs', () => {
  it('resolves the configured guild (not guilds.cache.first()) when the bot is in multiple guilds', async () => {
    const thread = makeThread();
    const owner = makeOwningGuild('guild-123', thread);
    const foreign = makeForeignGuild('other-guild-999');
    const client = makeMultiGuildClient(owner, foreign);

    insertActiveTrial({ name: 'Shadowleif', threadId: 'thread-1', logsMessageId: 'msg-1' });

    await updateTrialLogs(client);

    // Must have gone to the owning guild, not the foreign first() guild.
    expect(foreign.channels.fetch).not.toHaveBeenCalled();
    expect(owner.channels.fetch).toHaveBeenCalledWith('thread-1');
    expect(thread._existingMsg.edit).toHaveBeenCalledWith('LOGS CONTENT');
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

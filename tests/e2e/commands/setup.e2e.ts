import { describe, it, expect, beforeEach } from 'vitest';
import type { ChatInputCommandInteraction, TextBasedChannel } from 'discord.js';
import { getE2EContext } from '../setup/bootstrap.js';
import { fakeChatInput } from '../setup/synthesizer.js';
import { resetAndSeed } from '../setup/baseline.js';
import { queryOne } from '../setup/assertions.js';
import setupCmd from '../../../src/commands/setup.js';

// Helper: extract reply content string from a FakeReply.
function replyContent(reply: { options: unknown }): string {
  const opts = reply.options;
  if (typeof opts === 'string') return opts;
  return (opts as { content?: string }).content ?? '';
}

describe('/setup', () => {
  beforeEach(async () => {
    await resetAndSeed();
  });

  // ------------------------------------------------------------------ set_channel
  it('set_channel — stores the channel id in DB and replies ephemeral', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    // Snapshot channel count before.
    const channelsBefore = new Set(ctx.guild.channels.cache.keys());

    // Build a fake channel object to pass as the "channel" option value.
    // The handler only reads .id and .name from it.
    const targetChannel = channel;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'setup',
      subcommand: 'set_channel',
      options: {
        key: 'bot_logs_channel_id',
        channel: targetChannel,
      },
    });

    await setupCmd.execute(iact as unknown as ChatInputCommandInteraction);

    // Exactly one ephemeral reply.
    expect(iact.__replies.length).toBe(1);
    const reply = iact.__replies[0]!;
    expect(reply.ephemeral).toBe(true);

    // Reply must confirm the key was set.
    const content = replyContent(reply);
    expect(content).toContain('bot_logs_channel_id');

    // DB must have the key persisted.
    const row = queryOne<{ value: string }>('SELECT value FROM config WHERE key = ?', ['bot_logs_channel_id']);
    expect(row?.value).toBe(targetChannel.id);

    // No new channels were created — symmetric difference should be empty.
    const channelsAfter = new Set(ctx.guild.channels.cache.keys());
    const newChannels = [...channelsAfter].filter((id) => !channelsBefore.has(id));
    expect(newChannels).toHaveLength(0);
  });

  // ------------------------------------------------------------------ set_channel idempotency
  it('set_channel — running twice with the same channel overwrites cleanly (no duplicates)', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;
    const targetChannel = channel;

    const makeInteraction = () =>
      fakeChatInput({
        client: ctx.client,
        guild: ctx.guild,
        channel,
        member: ctx.officer,
        user: ctx.officer.user,
        commandName: 'setup',
        subcommand: 'set_channel',
        options: {
          key: 'guild_info_channel_id',
          channel: targetChannel,
        },
      });

    // First invocation.
    const first = makeInteraction();
    await setupCmd.execute(first as unknown as ChatInputCommandInteraction);
    expect(first.__replies.length).toBe(1);
    expect(first.__replies[0]!.ephemeral).toBe(true);

    // Second invocation (idempotent re-run).
    const second = makeInteraction();
    await setupCmd.execute(second as unknown as ChatInputCommandInteraction);
    expect(second.__replies.length).toBe(1);
    expect(second.__replies[0]!.ephemeral).toBe(true);

    // Only one row in DB for this key (INSERT OR REPLACE semantics).
    const rows = queryOne<{ cnt: number }>(
      'SELECT COUNT(*) AS cnt FROM config WHERE key = ?',
      ['guild_info_channel_id'],
    );
    expect(rows?.cnt).toBe(1);

    // Value still correct.
    const row = queryOne<{ value: string }>('SELECT value FROM config WHERE key = ?', ['guild_info_channel_id']);
    expect(row?.value).toBe(targetChannel.id);
  });

  // ------------------------------------------------------------------ set_role
  it('set_role — stores the role id in DB and replies ephemeral', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    // Use the officer member's first role (other than @everyone) as the target role.
    const officerRoles = ctx.officer.roles.cache.filter((r) => r.name !== '@everyone');
    const targetRole = officerRoles.first();
    if (!targetRole) throw new Error('officer has no non-everyone roles; sandbox guild misconfigured');

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'setup',
      subcommand: 'set_role',
      options: {
        key: 'officer_role_id',
        role: { id: targetRole.id, name: targetRole.name },
      },
    });

    await setupCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.__replies.length).toBe(1);
    const reply = iact.__replies[0]!;
    expect(reply.ephemeral).toBe(true);

    const content = replyContent(reply);
    expect(content).toContain('officer_role_id');

    const row = queryOne<{ value: string }>('SELECT value FROM config WHERE key = ?', ['officer_role_id']);
    expect(row?.value).toBe(targetRole.id);
  });

  // ------------------------------------------------------------------ get_config (empty)
  it('get_config — replies ephemeral with config listing when no keys are set', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'setup',
      subcommand: 'get_config',
    });

    await setupCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.__replies.length).toBe(1);
    const reply = iact.__replies[0]!;
    expect(reply.ephemeral).toBe(true);

    const content = replyContent(reply);
    // Handler replies with "Bot Configuration:" header regardless of row count.
    expect(content).toMatch(/Bot Configuration/i);
  });

  // ------------------------------------------------------------------ get_config reflects set_channel
  it('get_config — lists a key that was previously set via set_channel', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;
    const targetChannel = channel;

    // First, set a channel.
    const setIact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'setup',
      subcommand: 'set_channel',
      options: {
        key: 'loot_channel_id',
        channel: targetChannel,
      },
    });
    await setupCmd.execute(setIact as unknown as ChatInputCommandInteraction);

    // Now get_config should list the key.
    const getIact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'setup',
      subcommand: 'get_config',
    });
    await setupCmd.execute(getIact as unknown as ChatInputCommandInteraction);

    expect(getIact.__replies.length).toBe(1);
    const content = replyContent(getIact.__replies[0]!);
    expect(content).toContain('loot_channel_id');
    expect(content).toContain(targetChannel.id);
  });
});

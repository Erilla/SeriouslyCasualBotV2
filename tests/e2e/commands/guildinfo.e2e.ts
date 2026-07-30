import { describe, it, expect, beforeEach } from 'vitest';
import type { ChatInputCommandInteraction, TextBasedChannel } from 'discord.js';
import { getE2EContext } from '../setup/bootstrap.js';
import { fakeChatInput } from '../setup/synthesizer.js';
import { resetAndSeed } from '../setup/baseline.js';
import { getReadonlyTestDb } from '../setup/db.js';
import guildinfoCmd from '../../../src/commands/guildinfo.js';

function trackedMessageIds(): Record<string, string> {
  const rows = getReadonlyTestDb()
    .prepare('SELECT key, message_id FROM guild_info_messages ORDER BY key')
    .all() as { key: string; message_id: string }[];
  return Object.fromEntries(rows.map((row) => [row.key, row.message_id]));
}

describe('/guildinfo', () => {
  beforeEach(async () => {
    await resetAndSeed();
  });

  it('officer — replies ephemeral "Updating Guild Info..." then edits to "Guild Info updated."', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'guildinfo',
    });

    await guildinfoCmd.execute(iact as unknown as ChatInputCommandInteraction);

    // The handler calls interaction.reply() first, then interaction.editReply().
    expect(iact.__replies.length).toBe(1);
    const reply = iact.__replies[0]!;

    // Initial reply must be ephemeral.
    expect(reply.ephemeral).toBe(true);

    // Content must be the "Updating..." acknowledgement.
    const content =
      typeof reply.options === 'string'
        ? reply.options
        : ((reply.options as { content?: string }).content ?? '');
    expect(content).toMatch(/Updating Guild Info/i);

    // After the functions run, editReply must have been called with the success message.
    expect(iact.__editedReply).not.toBeNull();
    const editedContent =
      typeof iact.__editedReply!.options === 'string'
        ? iact.__editedReply!.options
        : ((iact.__editedReply!.options as { content?: string }).content ?? '');
    expect(editedContent).toMatch(/Guild Info updated/i);
  });

  it('second invocation preserves the four tracked message IDs', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const first = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'guildinfo',
    });

    await guildinfoCmd.execute(first as unknown as ChatInputCommandInteraction);
    const before = trackedMessageIds();
    expect(Object.keys(before)).toEqual(['aboutus', 'achievements', 'recruitment', 'schedule']);

    const second = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'guildinfo',
    });

    await guildinfoCmd.execute(second as unknown as ChatInputCommandInteraction);

    expect(trackedMessageIds()).toEqual(before);
  });

  it('force:true replaces tracked messages without deleting an unrelated channel message', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const initial = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'guildinfo',
    });

    await guildinfoCmd.execute(initial as unknown as ChatInputCommandInteraction);
    const before = trackedMessageIds();
    expect(Object.keys(before)).toEqual(['aboutus', 'achievements', 'recruitment', 'schedule']);

    const guildInfoChannelId = getReadonlyTestDb()
      .prepare("SELECT value FROM config WHERE key = 'guild_info_channel_id'")
      .get() as { value: string } | undefined;
    expect(guildInfoChannelId).toBeDefined();

    const guildInfoChannel = await ctx.guild.channels.fetch(guildInfoChannelId!.value);
    if (!guildInfoChannel?.isTextBased()) throw new Error('Guild Info channel is not text-based');
    const unrelated = await guildInfoChannel.send({ content: 'E2E unrelated Guild Info message' });

    const forced = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'guildinfo',
      options: { force: true },
    });

    await guildinfoCmd.execute(forced as unknown as ChatInputCommandInteraction);

    const after = trackedMessageIds();
    expect(Object.keys(after)).toEqual(['aboutus', 'achievements', 'recruitment', 'schedule']);
    for (const key of Object.keys(before)) {
      expect(after[key]).not.toBe(before[key]);
    }
    await expect(guildInfoChannel.messages.fetch(unrelated.id)).resolves.toMatchObject({
      id: unrelated.id,
    });
  });
});

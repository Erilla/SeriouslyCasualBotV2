import { describe, it, expect, beforeEach } from 'vitest';
import type { ChatInputCommandInteraction, TextBasedChannel } from 'discord.js';
import { MessageFlags } from 'discord.js';
import { getE2EContext } from '../setup/bootstrap.js';
import { fakeChatInput } from '../setup/synthesizer.js';
import { resetAndSeed } from '../setup/baseline.js';
import guildinfoCmd from '../../../src/commands/guildinfo.js';

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
        : (reply.options as { content?: string }).content ?? '';
    expect(content).toMatch(/Updating Guild Info/i);

    // After the functions run, editReply must have been called with the success message.
    expect(iact.__editedReply).not.toBeNull();
    const editedContent =
      typeof iact.__editedReply!.options === 'string'
        ? iact.__editedReply!.options
        : (iact.__editedReply!.options as { content?: string }).content ?? '';
    expect(editedContent).toMatch(/Guild Info updated/i);
  });

  it('second invocation — still replies ephemeral then edits to success', async () => {
    // Run it a second time to verify idempotency: the channel already has embeds
    // from the first beforeEach seed; clearGuildInfo should wipe them and re-post.
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

    expect(iact.__replies.length).toBe(1);
    const reply = iact.__replies[0]!;
    expect(reply.ephemeral).toBe(true);

    const content =
      typeof reply.options === 'string'
        ? reply.options
        : (reply.options as { content?: string }).content ?? '';
    expect(content).toMatch(/Updating Guild Info/i);

    expect(iact.__editedReply).not.toBeNull();
    const editedContent =
      typeof iact.__editedReply!.options === 'string'
        ? iact.__editedReply!.options
        : (iact.__editedReply!.options as { content?: string }).content ?? '';
    expect(editedContent).toMatch(/Guild Info updated/i);
  });
});

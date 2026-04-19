import { describe, it, expect, beforeEach } from 'vitest';
import type { ChatInputCommandInteraction, TextBasedChannel } from 'discord.js';
import { getE2EContext } from '../setup/bootstrap.js';
import { fakeChatInput } from '../setup/synthesizer.js';
import { resetAndSeed } from '../setup/baseline.js';
import helpCmd from '../../../src/commands/help.js';

describe('/help', () => {
  beforeEach(async () => {
    await resetAndSeed();
  });

  it('replies with a help listing that contains at least 3 known command names', async () => {
    const ctx = getE2EContext();

    const channel = ctx.guild.systemChannel as TextBasedChannel;
    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.tester,
      user: ctx.tester.user,
      commandName: 'help',
    });

    await helpCmd.execute(iact as unknown as ChatInputCommandInteraction);

    // The handler calls interaction.reply() directly — reply lands in __replies[0].
    expect(iact.__replies.length).toBe(1);
    const reply = iact.__replies[0]!.options;

    // reply is an InteractionReplyOptions object with an embeds array.
    expect(typeof reply).toBe('object');
    const replyObj = reply as { embeds?: unknown[] };
    expect(replyObj.embeds).toBeDefined();
    expect(Array.isArray(replyObj.embeds)).toBe(true);
    expect(replyObj.embeds!.length).toBeGreaterThan(0);

    // The embed is an EmbedBuilder — its description holds the command list.
    const embed = replyObj.embeds![0] as { data?: { description?: string } };
    const description = embed.data?.description ?? '';
    expect(typeof description).toBe('string');
    expect(description.length).toBeGreaterThan(0);

    // Assert that at least 3 known command names appear in the description.
    const knownCommands = [
      'ping', 'trials', 'applications', 'apply', 'epgp',
      'loot', 'raiders', 'status', 'guildinfo', 'settings',
      'setup', 'updateachievements', 'loglevel', 'testdata', 'help',
    ];
    const matchedCommands = knownCommands.filter((name) =>
      description.includes(`/${name}`),
    );
    expect(matchedCommands.length).toBeGreaterThanOrEqual(3);
  });
});

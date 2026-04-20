import { describe, it, expect, beforeEach } from 'vitest';
import type { ChatInputCommandInteraction, TextBasedChannel } from 'discord.js';
import { getE2EContext } from '../setup/bootstrap.js';
import { fakeChatInput } from '../setup/synthesizer.js';
import { resetAndSeed } from '../setup/baseline.js';
import pingCmd from '../../../src/commands/ping.js';

describe('/ping', () => {
  beforeEach(async () => {
    await resetAndSeed();
  });

  it('replies with latency information', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;
    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.tester,
      user: ctx.tester.user,
      commandName: 'ping',
    });

    await pingCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.__replies.length).toBe(1);
    expect(iact.__editedReply).not.toBeNull();
    const reply = iact.__editedReply!.options;
    const text = typeof reply === 'string' ? reply : (reply as { content?: string }).content ?? '';
    expect(text).toMatch(/Pong!/);
    expect(text).toMatch(/API Latency/);
  });
});

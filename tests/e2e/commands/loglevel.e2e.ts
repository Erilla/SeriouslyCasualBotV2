import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ChatInputCommandInteraction, TextBasedChannel } from 'discord.js';
import { getE2EContext } from '../setup/bootstrap.js';
import { fakeChatInput } from '../setup/synthesizer.js';
import { resetAndSeed } from '../setup/baseline.js';
import loglevelCmd from '../../../src/commands/loglevel.js';
import { logger } from '../../../src/services/logger.js';
import type { LogLevel } from '../../../src/types/index.js';

describe('/loglevel', () => {
  let originalLevel: LogLevel;

  beforeEach(async () => {
    await resetAndSeed();
    // Capture the level before each test so we can restore it after.
    originalLevel = logger.getLevel();
  });

  afterEach(() => {
    // Restore logger to its pre-test level so other tests aren't polluted.
    logger.setLevel(originalLevel);
  });

  it('get — replies with the current log level', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    // Ensure a known baseline level for the assertion.
    logger.setLevel('INFO');

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'loglevel',
      subcommand: 'get',
    });

    await loglevelCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.__replies.length).toBe(1);
    const reply = iact.__replies[0]!;
    expect(reply.ephemeral).toBe(true);
    const content =
      typeof reply.options === 'string'
        ? reply.options
        : (reply.options as { content?: string }).content ?? '';
    expect(content).toMatch(/Current log level/i);
    expect(content).toContain('INFO');
  });

  it('set — changes the logger level and replies with confirmation', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    // Start from a known level.
    logger.setLevel('INFO');

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'loglevel',
      subcommand: 'set',
      options: { level: 'DEBUG' },
    });

    await loglevelCmd.execute(iact as unknown as ChatInputCommandInteraction);

    // The logger singleton must now be at DEBUG.
    expect(logger.getLevel()).toBe('DEBUG');

    // The reply must acknowledge the change.
    expect(iact.__replies.length).toBe(1);
    const reply = iact.__replies[0]!;
    expect(reply.ephemeral).toBe(true);
    const content =
      typeof reply.options === 'string'
        ? reply.options
        : (reply.options as { content?: string }).content ?? '';
    expect(content).toContain('INFO');
    expect(content).toContain('DEBUG');
  });
});

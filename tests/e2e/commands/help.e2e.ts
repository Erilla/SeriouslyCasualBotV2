import { describe, it, expect, beforeEach } from 'vitest';
import { Collection } from 'discord.js';
import type { ChatInputCommandInteraction, TextBasedChannel } from 'discord.js';
import { getE2EContext } from '../setup/bootstrap.js';
import { fakeChatInput } from '../setup/synthesizer.js';
import { resetAndSeed } from '../setup/baseline.js';
import type { BotClient, Command } from '../../../src/types/index.js';
import helpCmd from '../../../src/commands/help.js';

// Import all command modules so we can populate client.commands exactly as the
// bot does — the /help handler iterates over this collection to build its list.
import applicationsCmd from '../../../src/commands/applications.js';
import applyCmd from '../../../src/commands/apply.js';
import epgpCmd from '../../../src/commands/epgp.js';
import guildinfoCmd from '../../../src/commands/guildinfo.js';
import loglevelCmd from '../../../src/commands/loglevel.js';
import lootCmd from '../../../src/commands/loot.js';
import pingCmd from '../../../src/commands/ping.js';
import raidersCmd from '../../../src/commands/raiders.js';
import settingsCmd from '../../../src/commands/settings.js';
import setupCmd from '../../../src/commands/setup.js';
import statusCmd from '../../../src/commands/status.js';
import testdataCmd from '../../../src/commands/testdata.js';
import trialsCmd from '../../../src/commands/trials.js';
import updateachievementsCmd from '../../../src/commands/updateachievements.js';

const ALL_COMMANDS: Command[] = [
  applicationsCmd,
  applyCmd,
  epgpCmd,
  guildinfoCmd,
  helpCmd,
  loglevelCmd,
  lootCmd,
  pingCmd,
  raidersCmd,
  settingsCmd,
  setupCmd,
  statusCmd,
  testdataCmd,
  trialsCmd,
  updateachievementsCmd,
];

describe('/help', () => {
  beforeEach(async () => {
    await resetAndSeed();
  });

  it('replies with a help listing that contains at least 3 known command names', async () => {
    const ctx = getE2EContext();

    // Attach a commands Collection to the real Discord client so the help
    // handler (which casts client to BotClient and reads client.commands) works.
    const botClient = ctx.client as unknown as BotClient;
    botClient.commands = new Collection<string, Command>();
    for (const cmd of ALL_COMMANDS) {
      botClient.commands.set(cmd.data.name, cmd);
    }

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

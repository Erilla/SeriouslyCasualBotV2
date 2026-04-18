import { getE2EContext } from './bootstrap.js';
import { fakeChatInput } from './synthesizer.js';
import { wipeTestDb } from './db.js';
import { initDatabase, closeDatabase } from '../../../src/database/db.js';
import { loadE2EEnv } from './env.js';
import testdataCmd from '../../../src/commands/testdata.js';
import type { ChatInputCommandInteraction, TextBasedChannel } from 'discord.js';

export async function resetAndSeed(): Promise<void> {
  const { client, guild, officer } = getE2EContext();
  const env = loadE2EEnv();

  closeDatabase();
  wipeTestDb();
  initDatabase(env.testDbPath);

  const channel = guild.systemChannel ?? guild.channels.cache.find((c) => c.isTextBased())!;

  const reset = fakeChatInput({
    client,
    guild,
    channel: channel as TextBasedChannel,
    member: officer,
    user: officer.user,
    commandName: 'testdata',
    subcommand: 'reset',
    options: { confirm: true },
  });
  await testdataCmd.execute(reset as unknown as ChatInputCommandInteraction);

  const seedAll = fakeChatInput({
    client,
    guild,
    channel: channel as TextBasedChannel,
    member: officer,
    user: officer.user,
    commandName: 'testdata',
    subcommand: 'seed_all',
    options: { discord: true },
  });
  await testdataCmd.execute(seedAll as unknown as ChatInputCommandInteraction);
}

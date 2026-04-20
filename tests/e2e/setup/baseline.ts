import { getE2EContext } from './bootstrap.js';
import { fakeChatInput } from './synthesizer.js';
import { wipeTestDb } from './db.js';
import { initDatabase, closeDatabase } from '../../../src/database/db.js';
import { loadE2EEnv } from './env.js';
import testdataCmd from '../../../src/commands/testdata.js';
import type { ChatInputCommandInteraction, TextBasedChannel } from 'discord.js';

export async function resetAndSeed(options: { discord?: boolean } = {}): Promise<void> {
  // Default to DB-only seeding. Tests that actually verify Discord-side
  // artifacts (e.g. applications-vote flow clicking a real seeded forum
  // thread) opt in with { discord: true }.
  const { discord = false } = options;
  const { client, guild, officer } = getE2EContext();
  const env = loadE2EEnv();

  closeDatabase();
  await wipeTestDb();
  initDatabase(env.testDbPath);

  const channel =
    guild.systemChannel ?? guild.channels.cache.find((c) => c.isTextBased());
  if (!channel) {
    throw new Error(
      `Sandbox guild ${guild.id} has no system channel and no text-based channel — ` +
      `cannot synthesize /testdata interaction for baseline reset.`,
    );
  }

  // We just wipeTestDb'd and initDatabase'd — invoking /testdata reset here
  // would wipe a fresh schema against its own freshly-seeded defaults, which
  // is wasted work. Jump straight to seed_all.
  const seedAll = fakeChatInput({
    client,
    guild,
    channel: channel as TextBasedChannel,
    member: officer,
    user: officer.user,
    commandName: 'testdata',
    subcommand: 'seed_all',
    options: { discord },
  });
  await testdataCmd.execute(seedAll as unknown as ChatInputCommandInteraction);
}

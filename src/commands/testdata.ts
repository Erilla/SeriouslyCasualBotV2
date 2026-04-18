import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import { requireOfficer } from '../utils.js';
import { getDatabase } from '../database/db.js';
import { seedRaiders } from '../functions/testdata/seedRaiders.js';
import { seedApplication } from '../functions/testdata/seedApplication.js';
import { seedTrial } from '../functions/testdata/seedTrial.js';
import { seedEpgp } from '../functions/testdata/seedEpgp.js';
import { seedLoot } from '../functions/testdata/seedLoot.js';
import { resetData } from '../functions/testdata/resetData.js';
import { logger } from '../services/logger.js';

export default {
  devOnly: true,
  data: new SlashCommandBuilder()
    .setName('testdata')
    .setDescription('Dev-only: seed or reset test data in the database')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub.setName('seed_raiders').setDescription('Insert 15 mock raiders into the database'),
    )
    .addSubcommand((sub) =>
      sub.setName('seed_application').setDescription('Insert a mock application with answers and votes'),
    )
    .addSubcommand((sub) =>
      sub.setName('seed_trial').setDescription('Insert a mock trial with 3 scheduled alerts'),
    )
    .addSubcommand((sub) =>
      sub.setName('seed_epgp').setDescription('Insert mock EPGP data for existing raiders'),
    )
    .addSubcommand((sub) =>
      sub.setName('seed_loot').setDescription('Insert 3 mock loot posts'),
    )
    .addSubcommand((sub) =>
      sub.setName('reset').setDescription('Wipe all test data and re-seed defaults'),
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!requireOfficer(interaction)) return;

    const sub = interaction.options.getSubcommand();
    const db = getDatabase();

    const handlers: Record<string, () => string> = {
      seed_raiders: () => {
        seedRaiders(db);
        return 'Seeded 15 mock raiders into the database.';
      },
      seed_application: () => {
        const r = seedApplication(db);
        return `Seeded 1 mock application (ID: ${r.applicationId}) with ${r.questionCount} answers and 2 votes.`;
      },
      seed_trial: () => {
        const r = seedTrial(db);
        return `Seeded 1 mock trial (ID: ${r.trialId}) with ${r.alertCount} trial alerts.`;
      },
      seed_epgp: () => {
        const r = seedEpgp(db);
        return [
          `Seeded EPGP data for **${r.raiderCount}** raiders:`,
          `• ${r.effortPointsInserted} effort point entries`,
          `• ${r.gearPointsInserted} gear point entries`,
          `• ${r.lootHistoryInserted} loot history entries`,
          `• ${r.uploadHistoryInserted} upload history record`,
        ].join('\n');
      },
      seed_loot: () => {
        const r = seedLoot(db);
        return `Seeded ${r.postsInserted} mock loot posts (boss IDs 99901-99903).`;
      },
      reset: () => {
        resetData(db);
        return 'All data wiped and defaults re-seeded successfully.';
      },
    };

    const handler = handlers[sub];
    if (!handler) return;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const message = handler();
      logger.info('TestData', `${sub}: ${message}`);
      await interaction.editReply({ content: message });
    } catch (err) {
      logger.error('TestData', `Failed to run ${sub}`, err as Error);
      const detail = err instanceof Error ? err.message : 'Check logs for details.';
      await interaction.editReply({ content: `Failed to run ${sub}. ${detail}` });
    }
  },
};

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

    if (sub === 'seed_raiders') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        const db = getDatabase();
        seedRaiders(db);
        logger.info('TestData', 'Seeded 15 mock raiders');
        await interaction.editReply({ content: 'Seeded 15 mock raiders into the database.' });
      } catch (err) {
        logger.error('TestData', 'Failed to seed raiders', err as Error);
        await interaction.editReply({ content: 'Failed to seed raiders. Check logs for details.' });
      }

      return;
    }

    if (sub === 'seed_application') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        const db = getDatabase();
        const result = seedApplication(db);
        logger.info('TestData', `Seeded mock application ID ${result.applicationId}`);
        await interaction.editReply({
          content: `Seeded 1 mock application (ID: ${result.applicationId}) with ${result.questionCount} answers and 2 votes.`,
        });
      } catch (err) {
        logger.error('TestData', 'Failed to seed application', err as Error);
        await interaction.editReply({ content: 'Failed to seed application. Check logs for details.' });
      }

      return;
    }

    if (sub === 'seed_trial') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        const db = getDatabase();
        const result = seedTrial(db);
        logger.info('TestData', `Seeded mock trial ID ${result.trialId}`);
        await interaction.editReply({
          content: `Seeded 1 mock trial (ID: ${result.trialId}) with ${result.alertCount} trial alerts.`,
        });
      } catch (err) {
        logger.error('TestData', 'Failed to seed trial', err as Error);
        await interaction.editReply({ content: 'Failed to seed trial. Check logs for details.' });
      }

      return;
    }

    if (sub === 'seed_epgp') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        const db = getDatabase();
        const result = seedEpgp(db);
        logger.info('TestData', `Seeded EPGP data for ${result.raiderCount} raiders`);
        await interaction.editReply({
          content: [
            `Seeded EPGP data for **${result.raiderCount}** raiders:`,
            `• ${result.effortPointsInserted} effort point entries`,
            `• ${result.gearPointsInserted} gear point entries`,
            `• ${result.lootHistoryInserted} loot history entries`,
            `• ${result.uploadHistoryInserted} upload history record`,
          ].join('\n'),
        });
      } catch (err) {
        logger.error('TestData', 'Failed to seed EPGP', err as Error);
        const message = err instanceof Error ? err.message : 'Check logs for details.';
        await interaction.editReply({ content: `Failed to seed EPGP. ${message}` });
      }

      return;
    }

    if (sub === 'seed_loot') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        const db = getDatabase();
        const result = seedLoot(db);
        logger.info('TestData', `Seeded ${result.postsInserted} mock loot posts`);
        await interaction.editReply({
          content: `Seeded ${result.postsInserted} mock loot posts (boss IDs 99901–99903).`,
        });
      } catch (err) {
        logger.error('TestData', 'Failed to seed loot', err as Error);
        await interaction.editReply({ content: 'Failed to seed loot posts. Check logs for details.' });
      }

      return;
    }

    if (sub === 'reset') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        const db = getDatabase();
        resetData(db);
        logger.info('TestData', 'Reset all data and re-seeded defaults');
        await interaction.editReply({
          content: 'All data wiped and defaults re-seeded successfully.',
        });
      } catch (err) {
        logger.error('TestData', 'Failed to reset data', err as Error);
        await interaction.editReply({ content: 'Failed to reset data. Check logs for details.' });
      }

      return;
    }
  },
};

import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import { requireOfficer } from '../utils.js';
import { getDatabase } from '../database/db.js';
import { seedRaiders } from '../functions/testdata/seedRaiders.js';
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
      sub.setName('seed_application').setDescription('Insert a mock application (not yet implemented)'),
    )
    .addSubcommand((sub) =>
      sub.setName('seed_trial').setDescription('Insert a mock trial (not yet implemented)'),
    )
    .addSubcommand((sub) =>
      sub.setName('seed_epgp').setDescription('Insert mock EPGP data (not yet implemented)'),
    )
    .addSubcommand((sub) =>
      sub.setName('seed_loot').setDescription('Insert mock loot posts (not yet implemented)'),
    )
    .addSubcommand((sub) =>
      sub.setName('reset').setDescription('Wipe all test data (not yet implemented)'),
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

    // Stubs for remaining subcommands
    const reply = { content: `\`${sub}\` is not yet implemented.`, flags: MessageFlags.Ephemeral } as const;
    await interaction.reply(reply);
  },
};

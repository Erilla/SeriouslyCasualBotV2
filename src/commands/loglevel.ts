import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import { logger } from '../services/logger.js';
import { requireOfficer } from '../utils.js';
import { audit } from '../services/auditLog.js';
import type { LogLevel } from '../types/index.js';

export default {
  data: new SlashCommandBuilder()
    .setName('loglevel')
    .setDescription('Get or set the bot log level')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) => sub.setName('get').setDescription('View current log level'))
    .addSubcommand((sub) =>
      sub
        .setName('set')
        .setDescription('Change log level at runtime')
        .addStringOption((opt) =>
          opt
            .setName('level')
            .setDescription('Log level')
            .setRequired(true)
            .addChoices(
              { name: 'DEBUG', value: 'DEBUG' },
              { name: 'INFO', value: 'INFO' },
              { name: 'WARN', value: 'WARN' },
              { name: 'ERROR', value: 'ERROR' },
            ),
        ),
    ),
  async execute(interaction: ChatInputCommandInteraction) {
    if (!(await requireOfficer(interaction))) return;

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'get') {
      await interaction.reply({ content: `Current log level: **${logger.getLevel()}**`, flags: MessageFlags.Ephemeral });
    }

    if (subcommand === 'set') {
      const level = interaction.options.getString('level', true) as LogLevel;
      const oldLevel = logger.getLevel();
      logger.setLevel(level);
      await audit(interaction.user, 'changed log level', `${oldLevel} -> ${level}`);
      await interaction.reply({ content: `Log level changed from **${oldLevel}** to **${level}**`, flags: MessageFlags.Ephemeral });
    }
  },
};

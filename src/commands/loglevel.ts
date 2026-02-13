import { SlashCommandBuilder, type ChatInputCommandInteraction, MessageFlags, PermissionFlagsBits } from 'discord.js';
import type { Command, LogLevel } from '../types/index.js';
import { logger } from '../services/logger.js';
import { requireAdmin } from '../utils/permissions.js';

const VALID_LEVELS: LogLevel[] = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];

const command: Command = {
    data: new SlashCommandBuilder()
        .setName('loglevel')
        .setDescription('Get or set the bot log level')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand((sub) =>
            sub.setName('get').setDescription('Get the current log level')
        )
        .addSubcommand((sub) =>
            sub
                .setName('set')
                .setDescription('Set the log level')
                .addStringOption((opt) =>
                    opt
                        .setName('level')
                        .setDescription('The log level to set')
                        .setRequired(true)
                        .addChoices(
                            ...VALID_LEVELS.map((l) => ({ name: l, value: l }))
                        )
                )
        ),

    async execute(interaction: ChatInputCommandInteraction) {
        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'get') {
            await interaction.reply({
                content: `Current log level: **${logger.getLevel()}**`,
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        if (subcommand === 'set') {
            if (!(await requireAdmin(interaction))) return;

            const level = interaction.options.getString('level', true) as LogLevel;
            logger.setLevel(level);

            await interaction.reply({
                content: `Log level set to **${level}**`,
                flags: MessageFlags.Ephemeral,
            });

            await logger.info(`Log level changed to ${level} by ${interaction.user.tag}`);
        }
    },
};

export default command;

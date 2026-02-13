import {
    SlashCommandBuilder,
    type ChatInputCommandInteraction,
    EmbedBuilder,
    Colors,
    MessageFlags,
    PermissionFlagsBits,
} from 'discord.js';
import type { Command } from '../types/index.js';
import { requireAdmin } from '../utils/permissions.js';
import { getSetting } from '../functions/settings/getSetting.js';
import { toggleSetting } from '../functions/settings/setSetting.js';
import { getAllSettings } from '../functions/settings/getAllSettings.js';

const TOGGLE_KEYS = [
    'alert_signups',
    'alert_mythicplus',
    'alert_trials',
    'alert_applications',
    'use_custom_applications',
];

const command: Command = {
    data: new SlashCommandBuilder()
        .setName('settings')
        .setDescription('Manage bot settings')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand((sub) =>
            sub
                .setName('get_setting')
                .setDescription('Get the value of a setting')
                .addStringOption((opt) =>
                    opt
                        .setName('key')
                        .setDescription('The setting key')
                        .setRequired(true)
                        .addChoices(
                            ...TOGGLE_KEYS.map((k) => ({ name: k, value: k }))
                        )
                )
        )
        .addSubcommand((sub) =>
            sub
                .setName('toggle_setting')
                .setDescription('Toggle a boolean setting on/off')
                .addStringOption((opt) =>
                    opt
                        .setName('key')
                        .setDescription('The setting key to toggle')
                        .setRequired(true)
                        .addChoices(
                            ...TOGGLE_KEYS.map((k) => ({ name: k, value: k }))
                        )
                )
        )
        .addSubcommand((sub) =>
            sub
                .setName('get_all_settings')
                .setDescription('View all current settings')
        ),

    async execute(interaction: ChatInputCommandInteraction) {
        if (!(await requireAdmin(interaction))) return;

        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'get_setting') {
            const key = interaction.options.getString('key', true);
            const value = getSetting(key);

            if (value === null) {
                await interaction.reply({
                    content: `Setting \`${key}\` not found.`,
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            const display = value === 'true' ? 'Enabled' : value === 'false' ? 'Disabled' : value;
            await interaction.reply({
                content: `**${key}**: ${display}`,
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        if (subcommand === 'toggle_setting') {
            const key = interaction.options.getString('key', true);
            const newValue = toggleSetting(key);
            const display = newValue ? 'Enabled' : 'Disabled';

            await interaction.reply({
                content: `**${key}** is now **${display}**`,
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        if (subcommand === 'get_all_settings') {
            const settings = getAllSettings();

            if (settings.length === 0) {
                await interaction.reply({
                    content: 'No settings configured.',
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            const embed = new EmbedBuilder()
                .setTitle('Bot Settings')
                .setColor(Colors.Blue)
                .setTimestamp();

            for (const setting of settings) {
                const display = setting.value === 'true'
                    ? 'Enabled'
                    : setting.value === 'false'
                        ? 'Disabled'
                        : setting.value;
                embed.addFields({ name: setting.key, value: display, inline: true });
            }

            await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        }
    },
};

export default command;

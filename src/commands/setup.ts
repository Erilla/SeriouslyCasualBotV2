import {
    SlashCommandBuilder,
    type ChatInputCommandInteraction,
    EmbedBuilder,
    Colors,
    ChannelType,
    ActivityType,
    MessageFlags,
    PermissionFlagsBits,
} from 'discord.js';
import type { Command } from '../types/index.js';
import { requireAdmin } from '../utils/permissions.js';
import { getChannel } from '../functions/setup/getChannel.js';
import { setChannel } from '../functions/setup/setChannel.js';
import { getAllChannels } from '../functions/setup/getAllChannels.js';
import { logger } from '../services/logger.js';

/** Configurable channel keys */
const CHANNEL_KEYS: Array<{ name: string; value: string; description: string }> = [
    { name: 'guild_info', value: 'guild_info', description: 'Guild info embeds channel' },
    { name: 'applications_category', value: 'applications_category', description: 'Applications category (legacy mode)' },
    { name: 'applications_forum', value: 'applications_forum', description: 'Applications forum channel' },
    { name: 'trial_review_forum', value: 'trial_review_forum', description: 'Trial review forum channel' },
    { name: 'raiders_lounge', value: 'raiders_lounge', description: 'Signup alerts & M+ reports' },
    { name: 'loot', value: 'loot', description: 'Loot posts channel' },
    { name: 'priority_loot', value: 'priority_loot', description: 'EPGP priority post channel' },
    { name: 'weekly_check', value: 'weekly_check', description: 'Weekly M+/vault reports' },
    { name: 'bot_setup', value: 'bot_setup', description: 'Bot admin area' },
    { name: 'audit', value: 'audit', description: 'Audit log channel' },
];

/** Configurable role keys */
const ROLE_KEYS: Array<{ name: string; value: string; description: string }> = [
    { name: 'admin_role', value: 'admin_role', description: 'Admin role for bot commands' },
    { name: 'raider_role', value: 'raider_role', description: 'Raider role for roster members' },
];

/** All config keys for display */
const ALL_KEYS = [...CHANNEL_KEYS, ...ROLE_KEYS];

/** Set of role key values for quick lookup */
const ROLE_KEY_SET = new Set(ROLE_KEYS.map((k) => k.value));

const command: Command = {
    data: new SlashCommandBuilder()
        .setName('setup')
        .setDescription('Configure bot channels and roles')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand((sub) =>
            sub
                .setName('set_channel')
                .setDescription('Assign a channel to a bot function')
                .addStringOption((opt) =>
                    opt
                        .setName('key')
                        .setDescription('The function to configure')
                        .setRequired(true)
                        .addChoices(
                            ...CHANNEL_KEYS.map((k) => ({ name: `${k.name} - ${k.description}`, value: k.value }))
                        )
                )
                .addChannelOption((opt) =>
                    opt
                        .setName('channel')
                        .setDescription('The channel to assign')
                        .setRequired(true)
                        .addChannelTypes(
                            ChannelType.GuildText,
                            ChannelType.GuildForum,
                            ChannelType.GuildCategory,
                        )
                )
        )
        .addSubcommand((sub) =>
            sub
                .setName('set_role')
                .setDescription('Assign a role to a bot function')
                .addStringOption((opt) =>
                    opt
                        .setName('key')
                        .setDescription('The function to configure')
                        .setRequired(true)
                        .addChoices(
                            ...ROLE_KEYS.map((k) => ({ name: `${k.name} - ${k.description}`, value: k.value }))
                        )
                )
                .addRoleOption((opt) =>
                    opt
                        .setName('role')
                        .setDescription('The role to assign')
                        .setRequired(true)
                )
        )
        .addSubcommand((sub) =>
            sub
                .setName('get_config')
                .setDescription('View all channel and role assignments')
        ),

    async execute(interaction: ChatInputCommandInteraction) {
        if (!(await requireAdmin(interaction))) return;

        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'set_channel') {
            const key = interaction.options.getString('key', true);
            const channel = interaction.options.getChannel('channel', true);
            const guildId = interaction.guildId!;

            setChannel(key, channel.id, guildId);

            await interaction.reply({
                content: `**${key}** is now set to <#${channel.id}>`,
                flags: MessageFlags.Ephemeral,
            });

            await logger.info(`[Setup] ${interaction.user.tag} set ${key} to #${channel.name} (${channel.id})`);

            interaction.client.user?.setActivity('SeriouslyCasual', {
                type: ActivityType.Watching,
            });
            return;
        }

        if (subcommand === 'set_role') {
            const key = interaction.options.getString('key', true);
            const role = interaction.options.getRole('role', true);
            const guildId = interaction.guildId!;

            setChannel(key, role.id, guildId);

            await interaction.reply({
                content: `**${key}** is now set to <@&${role.id}>`,
                flags: MessageFlags.Ephemeral,
            });

            await logger.info(`[Setup] ${interaction.user.tag} set ${key} to @${role.name} (${role.id})`);

            interaction.client.user?.setActivity('SeriouslyCasual', {
                type: ActivityType.Watching,
            });
            return;
        }

        if (subcommand === 'get_config') {
            const configs = getAllChannels();

            const embed = new EmbedBuilder()
                .setTitle('Bot Configuration')
                .setColor(Colors.Blue)
                .setTimestamp();

            if (configs.length === 0) {
                embed.setDescription('Nothing configured yet. Use `/setup set_channel` and `/setup set_role` to get started.');
            } else {
                const configMap = new Map(configs.map((c) => [c.key, c.channel_id]));

                for (const key of ALL_KEYS) {
                    const id = configMap.get(key.value);
                    let display = '*Not configured*';
                    if (id) {
                        display = ROLE_KEY_SET.has(key.value) ? `<@&${id}>` : `<#${id}>`;
                    }
                    embed.addFields({
                        name: key.value,
                        value: display,
                        inline: true,
                    });
                }
            }

            await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        }
    },
};

export default command;

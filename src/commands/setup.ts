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

/** All configurable channel/role keys and their descriptions */
const CONFIG_KEYS: Array<{ name: string; value: string; description: string }> = [
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
                            ...CONFIG_KEYS.map((k) => ({ name: `${k.name} - ${k.description}`, value: k.value }))
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
                .setName('get_channel')
                .setDescription('See which channel is assigned to a function')
                .addStringOption((opt) =>
                    opt
                        .setName('key')
                        .setDescription('The function to check')
                        .setRequired(true)
                        .addChoices(
                            ...CONFIG_KEYS.map((k) => ({ name: `${k.name} - ${k.description}`, value: k.value }))
                        )
                )
        )
        .addSubcommand((sub) =>
            sub
                .setName('get_config')
                .setDescription('View all channel assignments')
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

            // Update bot status now that setup has been done
            interaction.client.user?.setActivity('SeriouslyCasual', {
                type: ActivityType.Watching,
            });
            return;
        }

        if (subcommand === 'get_channel') {
            const key = interaction.options.getString('key', true);
            const channelId = getChannel(key);

            if (!channelId) {
                await interaction.reply({
                    content: `**${key}** is not configured. Use \`/setup set_channel\` to assign it.`,
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            await interaction.reply({
                content: `**${key}**: <#${channelId}>`,
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        if (subcommand === 'get_config') {
            const configs = getAllChannels();

            const embed = new EmbedBuilder()
                .setTitle('Bot Channel Configuration')
                .setColor(Colors.Blue)
                .setTimestamp();

            if (configs.length === 0) {
                embed.setDescription('No channels configured yet. Use `/setup set_channel` to get started.');
            } else {
                // Show all possible keys, marking unconfigured ones
                const configMap = new Map(configs.map((c) => [c.key, c.channel_id]));

                for (const key of CONFIG_KEYS) {
                    const channelId = configMap.get(key.value);
                    embed.addFields({
                        name: key.value,
                        value: channelId ? `<#${channelId}>` : '*Not configured*',
                        inline: true,
                    });
                }
            }

            await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        }
    },
};

export default command;

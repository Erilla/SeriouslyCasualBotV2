import {
    SlashCommandBuilder,
    type ChatInputCommandInteraction,
    MessageFlags,
    PermissionFlagsBits,
} from 'discord.js';
import type { Command } from '../types/index.js';
import { requireAdmin } from '../utils/permissions.js';
import { getChannel } from '../functions/setup/getChannel.js';
import { fetchTextChannel } from '../utils.js';
import { clearGuildInfo } from '../functions/guild-info/clearGuildInfo.js';
import { updateAboutUs } from '../functions/guild-info/updateAboutUs.js';
import { updateSchedule } from '../functions/guild-info/updateSchedule.js';
import { updateRecruitment } from '../functions/guild-info/updateRecruitment.js';
import { updateAchievements } from '../functions/guild-info/updateAchievements.js';

const command: Command = {
    data: new SlashCommandBuilder()
        .setName('guildinfo')
        .setDescription('Refresh all guild info embeds')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async execute(interaction: ChatInputCommandInteraction) {
        if (!(await requireAdmin(interaction))) return;

        const channelId = getChannel('guild_info');
        if (!channelId) {
            await interaction.reply({
                content: 'guild_info channel not configured. Run `/setup set_channel` first.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        await interaction.reply({ content: 'Updating Guild Info...', flags: MessageFlags.Ephemeral });

        const client = interaction.client;
        const textChannel = await fetchTextChannel(client, 'guild_info');
        if (!textChannel) {
            await interaction.editReply('Failed to fetch guild_info channel.');
            return;
        }

        await clearGuildInfo(client, textChannel);
        await updateAboutUs(client, textChannel);
        await updateSchedule(client, textChannel);
        await updateRecruitment(client, textChannel);
        await updateAchievements(client, textChannel);

        await interaction.editReply('Guild Info updated!');
    },
};

export default command;

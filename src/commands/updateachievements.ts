import {
    SlashCommandBuilder,
    type ChatInputCommandInteraction,
    MessageFlags,
    PermissionFlagsBits,
} from 'discord.js';
import type { Command } from '../types/index.js';
import { requireAdmin } from '../utils/permissions.js';
import { getChannel } from '../functions/setup/getChannel.js';
import { updateAchievements } from '../functions/guild-info/updateAchievements.js';

const command: Command = {
    data: new SlashCommandBuilder()
        .setName('updateachievements')
        .setDescription('Refresh the achievements embed with latest Raider.io data')
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

        await interaction.reply({ content: 'Updating achievements...', flags: MessageFlags.Ephemeral });

        await updateAchievements(interaction.client);

        await interaction.editReply('Achievements updated!');
    },
};

export default command;

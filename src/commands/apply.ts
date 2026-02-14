import {
    SlashCommandBuilder,
    type ChatInputCommandInteraction,
    MessageFlags,
} from 'discord.js';
import type { Command } from '../types/index.js';
import { getBooleanSetting } from '../functions/settings/getSetting.js';
import { startApplication } from '../functions/applications/startApplication.js';

const command: Command = {
    data: new SlashCommandBuilder()
        .setName('apply')
        .setDescription('Apply to join SeriouslyCasual'),

    async execute(interaction: ChatInputCommandInteraction) {
        // Check if custom applications are enabled
        if (!getBooleanSetting('use_custom_applications')) {
            await interaction.reply({
                content: 'Applications are currently handled externally. Please check the guild info channel for instructions.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        if (!getBooleanSetting('alert_applications')) {
            await interaction.reply({
                content: 'Applications are currently closed. Please try again later.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const error = await startApplication(interaction.user);

        if (error) {
            await interaction.editReply({ content: error });
        } else {
            await interaction.editReply({
                content: 'Check your DMs! I\'ve sent you the first question.',
            });
        }
    },
};

export default command;

import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  MessageFlags,
} from 'discord.js';
import { startApplication } from '../functions/applications/startApplication.js';

export default {
  data: new SlashCommandBuilder()
    .setName('apply')
    .setDescription('Apply to join the guild'),
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.reply({
      content: 'Check your DMs!',
      flags: MessageFlags.Ephemeral,
    });

    try {
      const success = await startApplication(interaction.user);
      if (!success) {
        await interaction.editReply('Failed to start application. Please make sure your DMs are open and try again.');
      }
    } catch {
      await interaction.editReply('Failed to start application. Please try again or contact an officer.');
    }
  },
};

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
    const success = await startApplication(interaction.user);

    if (success) {
      await interaction.reply({
        content: 'Check your DMs! I\'ve sent you the application questions.',
        flags: MessageFlags.Ephemeral,
      });
    } else {
      await interaction.reply({
        content: 'I was unable to send you a DM. Please make sure your DMs are open and try again.',
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};

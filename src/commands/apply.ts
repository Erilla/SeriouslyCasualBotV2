import { SlashCommandBuilder, type ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { startApplication } from '../functions/applications/startApplication.js';
import { resolveMember } from '../functions/applications/resolveMember.js';

export default {
  data: new SlashCommandBuilder().setName('apply').setDescription('Apply to join the guild'),
  async execute(interaction: ChatInputCommandInteraction) {
    // Deferred rather than answered up front: the applicant may be refused
    // (already a raider, application pending, recently declined), and promising
    // "Check your DMs!" before knowing that reads as a bug.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const result = await startApplication(interaction.user, await resolveMember(interaction));
      if (result.outcome === 'started') {
        await interaction.editReply("Check your DMs! I've sent you the application questions.");
      } else if (result.outcome === 'dm_failed') {
        await interaction.editReply(
          'Failed to start application. Please make sure your DMs are open and try again.',
        );
      } else {
        await interaction.editReply(result.message);
      }
    } catch {
      await interaction.editReply(
        'Failed to start application. Please try again or contact an officer.',
      );
    }
  },
};

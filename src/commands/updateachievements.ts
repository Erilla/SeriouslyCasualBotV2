import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import { requireOfficer, audit } from '../utils.js';
import { updateAchievements } from '../functions/guild-info/updateAchievements.js';

export default {
  data: new SlashCommandBuilder()
    .setName('updateachievements')
    .setDescription('Refresh achievements embed only')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction: ChatInputCommandInteraction) {
    if (!(await requireOfficer(interaction))) return;

    await interaction.reply({ content: 'Updating achievements...', flags: MessageFlags.Ephemeral });

    await updateAchievements(interaction.client);

    await audit(interaction.user, 'refreshed achievements', 'achievements embed');
    await interaction.editReply({ content: 'Achievements updated.' });
  },
};

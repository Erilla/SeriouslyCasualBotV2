import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import { requireOfficer, audit } from '../utils.js';
import { updateAchievements } from '../functions/guild-info/updateAchievements.js';
import { flushCache } from '../services/apiCache.js';

export default {
  data: new SlashCommandBuilder()
    .setName('updateachievements')
    .setDescription('Refresh achievements embed only')
    .addBooleanOption((option) =>
      option
        .setName('flush')
        .setDescription('Clear the Raider.IO/icon cache and refetch everything')
        .setRequired(false),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction: ChatInputCommandInteraction) {
    if (!(await requireOfficer(interaction))) return;

    const flush = interaction.options.getBoolean('flush') ?? false;

    await interaction.reply({ content: 'Updating achievements...', flags: MessageFlags.Ephemeral });

    if (flush) flushCache();

    try {
      await updateAchievements(interaction.client);
    } catch (error) {
      await interaction.editReply({ content: `Achievements update failed: ${error}` });
      return;
    }

    await audit(interaction.user, 'refreshed achievements', 'achievements embed');
    await interaction.editReply({
      content: flush ? 'Achievements updated (cache flushed).' : 'Achievements updated.',
    });
  },
};

import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import { requireOfficer, audit } from '../utils.js';
import { clearGuildInfo } from '../functions/guild-info/clearGuildInfo.js';
import { updateAboutUs } from '../functions/guild-info/updateAboutUs.js';
import { updateSchedule } from '../functions/guild-info/updateSchedule.js';
import { updateRecruitment } from '../functions/guild-info/updateRecruitment.js';
import { updateAchievements } from '../functions/guild-info/updateAchievements.js';

export default {
  data: new SlashCommandBuilder()
    .setName('guildinfo')
    .setDescription('Full refresh of all guild info embeds')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addBooleanOption((option) =>
      option
        .setName('force')
        .setDescription('Delete and recreate the four managed Guild Info messages')
        .setRequired(false),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    if (!(await requireOfficer(interaction))) return;

    await interaction.reply({ content: 'Updating Guild Info...', flags: MessageFlags.Ephemeral });

    const client = interaction.client;
    const force = interaction.options.getBoolean('force') ?? false;

    if (force) await clearGuildInfo(client);
    await updateAboutUs(client);
    await updateSchedule(client);
    await updateRecruitment(client);
    await updateAchievements(client);

    await audit(
      interaction.user,
      'refreshed guild info',
      force ? 'all embeds (force rebuild)' : 'all embeds',
    );
    await interaction.editReply({ content: 'Guild Info updated.' });
  },
};

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
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction: ChatInputCommandInteraction) {
    if (!(await requireOfficer(interaction))) return;

    await interaction.reply({ content: 'Updating Guild Info...', flags: MessageFlags.Ephemeral });

    const client = interaction.client;

    await clearGuildInfo(client);
    await updateAboutUs(client);
    await updateSchedule(client);
    await updateRecruitment(client);
    await updateAchievements(client);

    await audit(interaction.user, 'refreshed guild info', 'all embeds');
    await interaction.editReply({ content: 'Guild Info updated.' });
  },
};

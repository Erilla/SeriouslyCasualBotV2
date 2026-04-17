import { SlashCommandBuilder, type ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { createEmbed } from '../utils.js';
import { getDatabase } from '../database/db.js';
import { logger } from '../services/logger.js';

const startTime = Date.now();

export default {
  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show bot health and status'),
  async execute(interaction: ChatInputCommandInteraction) {
    const db = getDatabase();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = uptime % 60;

    const raiders = db.prepare('SELECT COUNT(*) as total, COUNT(discord_user_id) as linked FROM raiders').get() as { total: number; linked: number };
    const activeApps = db.prepare("SELECT COUNT(*) as count FROM applications WHERE status IN ('in_progress', 'submitted', 'active')").get() as { count: number };
    const activeTrials = db.prepare("SELECT COUNT(*) as count FROM trials WHERE status = 'active'").get() as { count: number };

    const embed = createEmbed('Bot Status')
      .addFields(
        { name: 'Uptime', value: `${hours}h ${minutes}m ${seconds}s`, inline: true },
        { name: 'Log Level', value: logger.getLevel(), inline: true },
        { name: '\u200b', value: '\u200b', inline: true },
        { name: 'Raiders', value: `${raiders.linked}/${raiders.total} linked`, inline: true },
        { name: 'Active Applications', value: `${activeApps.count}`, inline: true },
        { name: 'Active Trials', value: `${activeTrials.count}`, inline: true },
      );

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};

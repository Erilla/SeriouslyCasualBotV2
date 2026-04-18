import { statSync } from 'fs';
import { SlashCommandBuilder, type ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { createEmbed } from '../utils.js';
import { getDatabase } from '../database/db.js';
import { logger } from '../services/logger.js';
import { getTaskStatus } from '../services/statusTracker.js';

const startTime = Date.now();

function formatAge(date: Date | null | undefined): string {
  if (!date) return 'Never';
  const diffMs = Date.now() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return 'Just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const hours = Math.floor(diffMin / 60);
  const mins = diffMin % 60;
  return mins > 0 ? `${hours}h ${mins}m ago` : `${hours}h ago`;
}

function formatDbSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

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
    const epgpUpload = db.prepare('SELECT MAX(timestamp) as ts FROM epgp_upload_history').get() as { ts: string | null };

    const dbPath = process.env.DB_PATH || 'db.sqlite';
    let dbSizeStr = 'N/A';
    try {
      const stats = statSync(dbPath);
      dbSizeStr = formatDbSize(stats.size);
    } catch {
      // file not found or inaccessible
    }

    const syncStatus = getTaskStatus('syncRaiders');
    const achievementsStatus = getTaskStatus('updateAchievements');
    const trialLogsStatus = getTaskStatus('updateTrialLogs');

    const epgpLastUpload = epgpUpload?.ts ? formatAge(new Date(epgpUpload.ts)) : 'Never';

    const embed = createEmbed('Bot Status')
      .addFields(
        { name: 'Uptime', value: `${hours}h ${minutes}m ${seconds}s`, inline: true },
        { name: 'Log Level', value: logger.getLevel(), inline: true },
        { name: 'DB Size', value: dbSizeStr, inline: true },
        { name: 'Raiders', value: `${raiders.linked}/${raiders.total} linked`, inline: true },
        { name: 'Active Applications', value: `${activeApps.count}`, inline: true },
        { name: 'Active Trials', value: `${activeTrials.count}`, inline: true },
        { name: 'Last Roster Sync', value: formatAge(syncStatus?.lastRun), inline: true },
        { name: 'Last Achievements Update', value: formatAge(achievementsStatus?.lastRun), inline: true },
        { name: 'Last Trial Logs Update', value: formatAge(trialLogsStatus?.lastRun), inline: true },
        { name: 'EPGP Last Upload', value: epgpLastUpload, inline: true },
      );

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};

import { type Client, type TextChannel, ChannelType, AttachmentBuilder } from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { getHistoricalData, type WowAuditHistoricalEntry } from '../../services/wowaudit.js';
import { getWeeklyMythicPlusRuns } from '../../services/raiderio.js';
import { logger } from '../../services/logger.js';
import { config } from '../../config.js';
import { getOrCreateChannel } from '../channels.js';
import type { RaiderRow } from '../../types/index.js';

export async function generateMythicPlusReport(raiders: RaiderRow[]): Promise<string> {
  const lines: string[] = [];
  lines.push('Weekly Highest M+ Runs');
  lines.push('='.repeat(40));
  lines.push('');

  for (const raider of raiders) {
    try {
      const runs = await getWeeklyMythicPlusRuns(
        raider.region || 'eu',
        raider.realm || 'silvermoon',
        raider.character_name,
      );

      if (runs.length === 0) {
        lines.push(`${raider.character_name}: None`);
      } else {
        const levels = runs.map((r) => r.mythic_level).join(', ');
        lines.push(`${raider.character_name}: [${levels}]`);
      }
    } catch {
      lines.push(`${raider.character_name}: Error`);
    }
  }

  return lines.join('\n');
}

function extractVaultOption(
  data: Record<string, unknown> | undefined,
  category: string,
  option: string,
): string {
  if (!data) return '-';

  const vaultOptions = data.vault_options as Record<string, unknown> | undefined;
  if (!vaultOptions) return '-';

  const categoryData = vaultOptions[category] as Record<string, unknown> | undefined;
  if (!categoryData) return '-';

  const optionData = categoryData[option] as Record<string, unknown> | undefined;
  if (!optionData) return '-';

  const level = optionData.level ?? optionData.ilvl ?? optionData.item_level ?? '-';
  return String(level);
}

export async function generateGreatVaultReport(
  raiders: RaiderRow[],
  historicalData: WowAuditHistoricalEntry[],
): Promise<string> {
  const lines: string[] = [];

  // Build lookup from historical data
  const histMap = new Map<string, WowAuditHistoricalEntry>();
  for (const entry of historicalData) {
    histMap.set(entry.character.name.toLowerCase(), entry);
  }

  // Find max name length for alignment
  const maxNameLen = Math.max(14, ...raiders.map((r) => r.character_name.length));

  const header =
    'Character Name'.padEnd(maxNameLen + 2) +
    'Raid'.padEnd(20) +
    'Dungeon'.padEnd(20) +
    'World'.padEnd(20);

  lines.push('Weekly Great Vault Report');
  lines.push('='.repeat(header.length));
  lines.push('');
  lines.push(header);
  lines.push('-'.repeat(header.length));

  for (const raider of raiders) {
    const entry = histMap.get(raider.character_name.toLowerCase());
    const data = entry?.data as Record<string, unknown> | undefined;

    const raidOpts = [
      extractVaultOption(data, 'raids', 'option_1'),
      extractVaultOption(data, 'raids', 'option_2'),
      extractVaultOption(data, 'raids', 'option_3'),
    ].join('/');

    const dungeonOpts = [
      extractVaultOption(data, 'dungeons', 'option_1'),
      extractVaultOption(data, 'dungeons', 'option_2'),
      extractVaultOption(data, 'dungeons', 'option_3'),
    ].join('/');

    const worldOpts = [
      extractVaultOption(data, 'world', 'option_1'),
      extractVaultOption(data, 'world', 'option_2'),
      extractVaultOption(data, 'world', 'option_3'),
    ].join('/');

    const line =
      raider.character_name.padEnd(maxNameLen + 2) +
      raidOpts.padEnd(20) +
      dungeonOpts.padEnd(20) +
      worldOpts.padEnd(20);

    lines.push(line);
  }

  return lines.join('\n');
}

export async function alertHighestMythicPlusDone(client: Client): Promise<void> {
  const db = getDatabase();
  const raiders = db
    .prepare('SELECT * FROM raiders ORDER BY character_name')
    .all() as RaiderRow[];

  if (raiders.length === 0) {
    logger.info('WeeklyReports', 'No raiders in database, skipping weekly reports');
    return;
  }

  const dateStr = new Date().toISOString().split('T')[0];

  // Generate M+ report
  let mplusContent: string;
  try {
    mplusContent = await generateMythicPlusReport(raiders);
  } catch (error) {
    logger.error('WeeklyReports', 'Failed to generate M+ report', error as Error);
    mplusContent = 'Error generating M+ report';
  }

  // Generate Great Vault report
  let vaultContent: string;
  try {
    const historicalData = await getHistoricalData();
    vaultContent = await generateGreatVaultReport(raiders, historicalData);
  } catch (error) {
    logger.error('WeeklyReports', 'Failed to generate Great Vault report', error as Error);
    vaultContent = 'Error generating Great Vault report';
  }

  // Create file attachments
  const mplusFile = new AttachmentBuilder(Buffer.from(mplusContent), {
    name: `highest_mythicplus_${dateStr}.txt`,
  });

  const vaultFile = new AttachmentBuilder(Buffer.from(vaultContent), {
    name: `great_vaults_${dateStr}.txt`,
  });

  // Get the weekly-check channel
  const guild = await client.guilds.fetch(config.guildId);
  const channel = (await getOrCreateChannel(guild, {
    name: 'weekly-check',
    type: ChannelType.GuildText,
    categoryName: 'Overlords',
    configKey: 'weekly_check_channel_id',
  })) as TextChannel;

  try {
    await channel.send({
      content: `**Weekly Reports** - ${dateStr}`,
      files: [mplusFile, vaultFile],
    });
    logger.info('WeeklyReports', `Sent weekly reports for ${dateStr}`);
  } catch (error) {
    logger.error('WeeklyReports', 'Failed to send weekly reports', error as Error);
  }
}

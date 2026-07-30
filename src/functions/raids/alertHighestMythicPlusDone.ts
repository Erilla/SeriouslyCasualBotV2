import { type Client, ChannelType, AttachmentBuilder, type TextChannel } from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { getHistoricalData, type WowAuditHistoricalEntry } from '../../services/wowaudit.js';
import { getCharacterEquipment } from '../../services/blizzard.js';
import { getPreviousWeekProfile } from '../../services/raiderio.js';
import { logger } from '../../services/logger.js';
import { config } from '../../config.js';
import { getOrCreateChannel } from '../channels.js';
import type { RaiderRow } from '../../types/index.js';
import {
  getDungeonVaultChoices,
  getUnlockedChoiceCount,
  type VaultOptions,
  type WeeklyReadinessRow,
} from './weeklyReadiness.js';

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

type WeeklyReportInput = WeeklyReadinessRow[] | RaiderRow[];

function isWeeklyReadinessRow(row: WeeklyReadinessRow | RaiderRow): row is WeeklyReadinessRow {
  return 'characterName' in row;
}

export async function loadWeeklyReadinessRows(raiders: RaiderRow[]): Promise<WeeklyReadinessRow[]> {
  return Promise.all(
    raiders.map(async (raider) => {
      const region = raider.region || 'eu';
      const realm = raider.realm || 'silvermoon';
      const [profileResult, equipmentResult] = await Promise.allSettled([
        getPreviousWeekProfile(region, realm, raider.character_name),
        getCharacterEquipment(region, realm, raider.character_name),
      ]);

      if (profileResult.status === 'rejected') {
        logger.error(
          'WeeklyReports',
          `Failed Raider.IO lookup for ${raider.character_name}`,
          asError(profileResult.reason),
        );
      }

      if (equipmentResult.status === 'rejected') {
        logger.error(
          'WeeklyReports',
          `Failed Blizzard equipment lookup for ${raider.character_name}`,
          asError(equipmentResult.reason),
        );
      }

      return {
        characterName: raider.character_name,
        runs: profileResult.status === 'fulfilled' ? profileResult.value.runs : null,
        lastCrawledAt:
          profileResult.status === 'fulfilled' ? profileResult.value.lastCrawledAt : null,
        equipment: equipmentResult.status === 'fulfilled' ? equipmentResult.value : null,
      };
    }),
  );
}

async function resolveWeeklyReadinessRows(input: WeeklyReportInput): Promise<WeeklyReadinessRow[]> {
  if (input.length === 0 || isWeeklyReadinessRow(input[0])) {
    return input as WeeklyReadinessRow[];
  }

  return loadWeeklyReadinessRows(input as RaiderRow[]);
}

export async function generateMythicPlusReport(input: WeeklyReportInput): Promise<string> {
  const rows = await resolveWeeklyReadinessRows(input);
  const lines: string[] = [];
  lines.push('Weekly Highest M+ Runs');
  lines.push('='.repeat(40));
  lines.push('');

  for (const row of rows) {
    if (row.runs == null) {
      lines.push(`${row.characterName}: Error`);
    } else if (row.runs.length === 0) {
      lines.push(`${row.characterName}: None`);
    } else {
      const levels = row.runs.map((run) => run.mythic_level).join(', ');
      lines.push(`${row.characterName}: [${levels}]`);
    }
  }

  return lines.join('\n');
}

function getVaultOptions(
  data: Record<string, unknown> | undefined,
  category: string,
): VaultOptions | undefined {
  if (!data) return undefined;

  const vaultOptions = data.vault_options as Record<string, unknown> | undefined;
  if (!vaultOptions) return undefined;

  const categoryData = vaultOptions[category] as Record<string, unknown> | undefined;
  return categoryData as VaultOptions | undefined;
}

function formatDungeonChoices(row: WeeklyReadinessRow): string {
  return getDungeonVaultChoices(row.runs ?? [])
    .map((level) => (level == null ? '-' : `+${level}`))
    .join(' / ');
}

export async function generateGreatVaultReport(
  input: WeeklyReportInput,
  historicalData: WowAuditHistoricalEntry[],
): Promise<string> {
  const rows = await resolveWeeklyReadinessRows(input);
  const lines: string[] = [];

  // Build lookup from historical data
  const histMap = new Map<string, WowAuditHistoricalEntry>();
  for (const entry of historicalData) {
    histMap.set(entry.name.toLowerCase(), entry);
  }

  // Find max name length for alignment
  const maxNameLen = Math.max(14, ...rows.map((row) => row.characterName.length));

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

  for (const row of rows) {
    const entry = histMap.get(row.characterName.toLowerCase());
    const data = entry?.data as Record<string, unknown> | undefined;
    const raidOpts = String(getUnlockedChoiceCount(getVaultOptions(data, 'raids')));
    const dungeonOpts = formatDungeonChoices(row);
    const worldOpts = String(getUnlockedChoiceCount(getVaultOptions(data, 'world')));

    const line =
      row.characterName.padEnd(maxNameLen + 2) +
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
    .prepare('SELECT * FROM raiders WHERE inactive_since IS NULL ORDER BY character_name')
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
  let channel: TextChannel;
  try {
    const guild = await client.guilds.fetch(config.guildId);
    channel = await getOrCreateChannel(guild, {
      name: 'weekly-check',
      type: ChannelType.GuildText,
      categoryName: 'Overlords',
      configKey: 'weekly_check_channel_id',
    });
  } catch (error) {
    logger.error('WeeklyCheck', 'Failed to resolve weekly-check channel', error as Error);
    return;
  }

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

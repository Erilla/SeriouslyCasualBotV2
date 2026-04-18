import { type Client, AttachmentBuilder } from 'discord.js';
import { createCanvas } from '@napi-rs/canvas';
import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';
import { getOrCreateGuildInfoChannel } from './clearGuildInfo.js';
import { getRaidStaticData, getRaidRankings } from '../../services/raiderio.js';
import type { AchievementsManualRow, GuildInfoContentRow, GuildInfoMessageRow } from '../../types/index.js';

// ─── Expansion Names ───────────────────────────────────────────

const EXPANSION_NAMES: Record<number, string> = {
  1: 'Classic',
  2: 'The Burning Crusade',
  3: 'Wrath of the Lich King',
  4: 'Mists of Pandaria',
  5: 'Warlords of Draenor',
  6: 'Legion',
  7: 'Battle for Azeroth',
  8: 'Shadowlands',
  9: 'Dragonflight',
  10: 'The War Within',
  11: 'Midnight',
};

function getExpansionName(id: number): string {
  return EXPANSION_NAMES[id] ?? `Expansion ${id}`;
}

// ─── Types ──────────────────────────────────────────────────────

interface AchievementRow {
  raid: string;
  progress: string;
  result: string;
  isCE: boolean;
}

interface AchievementSection {
  expansionLabel: string | null;
  rows: AchievementRow[];
}

interface RaidStaticRaid {
  id: number;
  slug: string;
  name: string;
  short_name?: string;
  expansion_id: number;
  encounters: Array<{
    id: number;
    slug: string;
    name: string;
  }>;
  starts?: Record<string, string>;
  ends?: Record<string, string | null>;
}

interface RaidRankingEntry {
  rank: number;
  guild: {
    name: string;
    realm: string;
    region: string;
  };
  encountersDefeated: number;
  encountersTotal: number;
  encounter_defeated?: Array<{
    slug: string;
    lastDefeated: string;
    firstDefeated: string;
  }>;
}

// ─── Main Export ─────────────────────────────────────────────────

/**
 * Generate achievements image from manual + API data and post to guild info channel.
 */
export async function updateAchievements(client: Client): Promise<void> {
  const channel = await getOrCreateGuildInfoChannel(client);
  if (!channel) {
    logger.warn('guild-info', 'Could not resolve guild info channel for Achievements');
    return;
  }

  const db = getDatabase();

  // Get manual achievements
  const manualRows = db
    .prepare('SELECT * FROM achievements_manual ORDER BY expansion, sort_order')
    .all() as AchievementsManualRow[];

  // Get achievements title
  const titleRow = db
    .prepare('SELECT * FROM guild_info_content WHERE key = ?')
    .get('achievements_title') as GuildInfoContentRow | undefined;
  const title = titleRow?.title ?? 'Current Progress & Past Achievements';

  // Build manual sections grouped by expansion
  const manualSections = buildManualSections(manualRows);

  // Fetch API achievements for expansions 6+
  const apiSections = await fetchApiAchievements();

  // Combine: API sections (reverse chronological) first, then manual sections (reverse chronological)
  const allSections = [...apiSections.reverse(), ...manualSections.reverse()];

  // Render as PNG
  const imageBuffer = renderAchievementsImage(allSections, title);

  // Build attachment
  const attachment = new AttachmentBuilder(imageBuffer, { name: 'achievements.png' });

  // Check if a previous achievements message exists
  const existingMsg = db
    .prepare('SELECT * FROM guild_info_messages WHERE key = ?')
    .get('achievements') as GuildInfoMessageRow | undefined;

  if (existingMsg) {
    try {
      const oldMessage = await channel.messages.fetch(existingMsg.message_id);
      await oldMessage.edit({
        content: `**${title}**`,
        embeds: [],
        files: [attachment],
      });
      logger.info('guild-info', 'Updated existing Achievements message');
      return;
    } catch {
      logger.debug('guild-info', 'Previous achievements message not found, creating new one');
    }
  }

  // Send new message
  const message = await channel.send({
    content: `**${title}**`,
    files: [attachment],
  });

  db.prepare('INSERT OR REPLACE INTO guild_info_messages (key, message_id) VALUES (?, ?)').run(
    'achievements',
    message.id,
  );

  logger.info('guild-info', 'Posted Achievements image');
}

// ─── Manual Sections ────────────────────────────────────────────

function buildManualSections(rows: AchievementsManualRow[]): AchievementSection[] {
  const grouped = new Map<number, AchievementsManualRow[]>();

  for (const row of rows) {
    const existing = grouped.get(row.expansion) ?? [];
    existing.push(row);
    grouped.set(row.expansion, existing);
  }

  const sections: AchievementSection[] = [];

  for (const [expansion, expRows] of grouped) {
    sections.push({
      expansionLabel: getExpansionName(expansion),
      rows: expRows.map((r) => {
        const isCE = r.result.includes('CE');
        const result = r.result.replace(/\*\*/g, '').replace(/^CE\s*/, '').trim();
        return { raid: r.raid, progress: r.progress, result, isCE };
      }).reverse(),
    });
  }

  return sections;
}

// ─── API Achievements ───────────────────────────────────────────

async function fetchApiAchievements(): Promise<AchievementSection[]> {
  const sections: AchievementSection[] = [];
  let expansionId = 6;

  logger.info('Achievements', 'Fetching API achievements starting from expansion 6');

  while (true) {
    let staticData;
    try {
      staticData = await getRaidStaticData(expansionId);
    } catch {
      logger.debug('Achievements', `No data for expansion ${expansionId}, stopping`);
      break;
    }

    const raids = (staticData.raids ?? []) as RaidStaticRaid[];
    if (raids.length === 0) break;

    const expName = getExpansionName(expansionId);
    logger.info('Achievements', `Processing ${expName}: ${raids.length} raids found`);

    // Sort raids by end date descending (most recent first, ongoing at top)
    const sortedRaids = [...raids].sort((a, b) => {
      const endA = a.ends?.eu ?? a.ends?.us ?? '';
      const endB = b.ends?.eu ?? b.ends?.us ?? '';
      if (!endA && !endB) return 0;
      if (!endA) return -1; // ongoing raids sort to top
      if (!endB) return 1;
      return endB.localeCompare(endA);
    });

    const sectionRows: AchievementRow[] = [];

    for (const raid of sortedRaids) {
      // Skip Fated/Awakened raids
      if (raid.name.startsWith('Fated') || raid.name.startsWith('Awakened')) {
        logger.debug('Achievements', `Skipping ${raid.name} (Fated/Awakened)`);
        continue;
      }

      try {
        const rankings = await getRaidRankings(raid.slug) as unknown as RaidRankingEntry[];

        if (!rankings || rankings.length === 0) {
          logger.debug('Achievements', `No rankings for ${raid.name}`);
          continue;
        }

        // Use the ranking entry with the most encounters defeated
        // Guard against encountersDefeated being an array (API may return either)
        const getDefeatedCount = (entry: RaidRankingEntry): number => {
          const val = entry.encountersDefeated;
          if (Array.isArray(val)) return (val as unknown[]).length;
          if (typeof val === 'number') return val;
          return 0;
        };

        const best = rankings.reduce((a, b) =>
          (getDefeatedCount(b) > getDefeatedCount(a) ? b : a), rankings[0]);

        const killedBosses = getDefeatedCount(best);
        const totalBosses = typeof best.encountersTotal === 'number'
          ? best.encountersTotal
          : raid.encounters.length;

        if (killedBosses === 0) continue;

        // Determine CE status
        const isCE = determineCE(raid, best);

        const progress = `${killedBosses}/${totalBosses}M`;
        const rank = typeof best.rank === 'number' ? best.rank : 0;
        const result = rank > 0 ? `WR ${rank}` : '';

        logger.info('Achievements', `  ${raid.name}: ${progress} ${isCE ? 'CE' : ''} ${result}`);

        sectionRows.push({
          raid: raid.name,
          progress,
          result,
          isCE,
        });
      } catch (error) {
        logger.warn('Achievements', `Failed to fetch rankings for ${raid.name} (${raid.slug}): ${error}`);
      }
    }

    if (sectionRows.length > 0) {
      sections.push({
        expansionLabel: expName,
        rows: sectionRows,
      });
    }

    expansionId++;
  }

  logger.info('Achievements', `Fetched ${sections.length} expansion sections with ${sections.reduce((sum, s) => sum + s.rows.length, 0)} total raids`);
  return sections;
}

function determineCE(raid: RaidStaticRaid, ranking: RaidRankingEntry): boolean {
  const totalBosses = typeof ranking.encountersTotal === 'number'
    ? ranking.encountersTotal
    : raid.encounters.length;

  // Not all bosses killed = no CE
  const defeated = Array.isArray(ranking.encountersDefeated)
    ? (ranking.encountersDefeated as unknown[]).length
    : (typeof ranking.encountersDefeated === 'number' ? ranking.encountersDefeated : 0);
  if (defeated < totalBosses) return false;

  // Get the tier end date
  const endDate = raid.ends?.eu ?? null;

  // If ends.eu is null (ongoing tier), CE = all bosses killed
  if (!endDate) return true;

  // Check if the last boss was defeated before the tier end date
  if (ranking.encounter_defeated && ranking.encounter_defeated.length > 0) {
    const lastEncounterSlug = raid.encounters[raid.encounters.length - 1]?.slug;
    const lastBossEntry = ranking.encounter_defeated.find(
      (e) => e.slug === lastEncounterSlug,
    );
    if (lastBossEntry) {
      return new Date(lastBossEntry.firstDefeated) < new Date(endDate);
    }
  }

  // If we can't determine timing but all bosses are killed, assume CE
  return true;
}

// ─── Image Rendering ────────────────────────────────────────────

function renderAchievementsImage(sections: AchievementSection[], title: string): Buffer {
  const PADDING = 32;
  const ROW_HEIGHT = 38;
  const HEADER_HEIGHT = 56;
  const SECTION_GAP = 20;
  const FONT_SIZE = 22;
  const HEADER_FONT_SIZE = 24;
  const WIDTH = 1400;

  // Column positions
  const COL_RAID = PADDING;
  const COL_PROGRESS = 720;
  const COL_CE = 900;
  const COL_RESULT = 1060;

  // CE badge dimensions
  const CE_BADGE_W = 54;
  const CE_BADGE_H = 26;
  const CE_BADGE_RADIUS = 5;

  // Calculate total height
  let totalRows = 0;
  for (const section of sections) {
    totalRows += section.rows.length;
    if (section.expansionLabel) totalRows++; // separator row
  }

  const height = PADDING + HEADER_HEIGHT + totalRows * ROW_HEIGHT + sections.length * SECTION_GAP + PADDING;

  const canvas = createCanvas(WIDTH, height);
  const ctx = canvas.getContext('2d');

  // Dark background (Discord dark theme)
  ctx.fillStyle = '#2b2d31';
  ctx.fillRect(0, 0, WIDTH, height);

  // Column headers
  ctx.fillStyle = '#96989d';
  ctx.font = `bold ${HEADER_FONT_SIZE}px sans-serif`;
  ctx.fillText('RAID', COL_RAID, PADDING + 20);
  ctx.fillText('PROGRESS', COL_PROGRESS, PADDING + 20);
  ctx.fillText('CE', COL_CE + 10, PADDING + 20);
  ctx.fillText('WORLD RANK', COL_RESULT, PADDING + 20);

  // Header underline
  ctx.strokeStyle = '#3f4147';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PADDING, PADDING + HEADER_HEIGHT - 4);
  ctx.lineTo(WIDTH - PADDING, PADDING + HEADER_HEIGHT - 4);
  ctx.stroke();

  let y = PADDING + HEADER_HEIGHT + ROW_HEIGHT;

  for (const section of sections) {
    // Expansion separator
    if (section.expansionLabel) {
      ctx.fillStyle = '#5865f2';
      ctx.font = `bold ${FONT_SIZE}px sans-serif`;
      ctx.fillText(section.expansionLabel, COL_RAID, y);
      y += ROW_HEIGHT;
    }

    for (const row of section.rows) {
      const color = row.isCE ? '#57f287' : '#ffffff';

      ctx.fillStyle = color;
      ctx.font = `${FONT_SIZE}px sans-serif`;
      ctx.fillText(row.raid, COL_RAID, y);
      ctx.fillText(row.progress, COL_PROGRESS, y);
      ctx.fillText(row.result, COL_RESULT, y);

      // CE badge
      if (row.isCE) {
        const badgeX = COL_CE;
        const badgeY = y - CE_BADGE_H + 4;

        // Rounded rectangle background
        ctx.beginPath();
        ctx.roundRect(badgeX, badgeY, CE_BADGE_W, CE_BADGE_H, CE_BADGE_RADIUS);
        ctx.fillStyle = '#248046';
        ctx.fill();

        // CE text centered in badge
        ctx.fillStyle = '#ffffff';
        ctx.font = `bold 16px sans-serif`;
        const textWidth = ctx.measureText('CE').width;
        ctx.fillText('CE', badgeX + (CE_BADGE_W - textWidth) / 2, y - 2);
      }

      y += ROW_HEIGHT;
    }

    y += SECTION_GAP;
  }

  return Buffer.from(canvas.toBuffer('image/png'));
}

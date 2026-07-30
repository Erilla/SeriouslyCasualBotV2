import { type Client, AttachmentBuilder } from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';
import { getOrCreateGuildInfoChannel } from './clearGuildInfo.js';
import { upsertGuildInfoMessage } from './managedGuildInfoMessage.js';
import { buildAchievementsModel } from './achievementsData.js';
import { renderAchievementsImage } from './achievementsRender.js';
import type { GuildInfoContentRow } from '../../types/index.js';

/**
 * Generate the achievements image from manual + API data and post it to the
 * guild info channel. Fail-fast: any fetch or render error propagates to the
 * caller and the existing Discord message is left untouched.
 */
export async function updateAchievements(client: Client): Promise<void> {
  const channel = await getOrCreateGuildInfoChannel(client);
  if (!channel) {
    logger.warn('guild-info', 'Could not resolve guild info channel for Achievements');
    return;
  }

  const db = getDatabase();

  const titleRow = db
    .prepare('SELECT * FROM guild_info_content WHERE key = ?')
    .get('achievements_title') as GuildInfoContentRow | undefined;
  const title = titleRow?.title ?? 'Current Progress & Past Achievements';

  const model = await buildAchievementsModel();
  const imageBuffer = await renderAchievementsImage(model);
  const attachment = new AttachmentBuilder(imageBuffer, { name: 'achievements.png' });

  await upsertGuildInfoMessage(channel, 'achievements', {
    content: `**${title}**`,
    embeds: [],
    files: [attachment],
  });

  logger.info('guild-info', 'Posted Achievements image');
}

import { type Client, AttachmentBuilder } from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';
import { getOrCreateGuildInfoChannel } from './clearGuildInfo.js';
import { buildAchievementsModel } from './achievementsData.js';
import { renderAchievementsImage } from './achievementsRender.js';
import type { GuildInfoContentRow, GuildInfoMessageRow } from '../../types/index.js';

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
    } catch (error) {
      // Editing can fail because the stored message was deleted, the channel was
      // recreated, or the message was authored by a different bot identity. Log
      // the reason so a stray duplicate post is diagnosable rather than silent.
      logger.warn(
        'guild-info',
        `Could not edit existing achievements message ${existingMsg.message_id}, creating new one: ${error}`,
      );
    }
  }

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

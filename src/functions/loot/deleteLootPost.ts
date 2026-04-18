import type { Client } from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';
import type { LootPostRow } from '../../types/index.js';

export async function deleteLootPost(client: Client, bossId: number): Promise<void> {
  const db = getDatabase();

  const lootPost = db
    .prepare('SELECT * FROM loot_posts WHERE boss_id = ?')
    .get(bossId) as LootPostRow | undefined;

  if (!lootPost) {
    logger.warn('Loot', `No loot post found for boss_id ${bossId}`);
    return;
  }

  // Delete Discord message
  try {
    const channel = await client.channels.fetch(lootPost.channel_id);
    if (channel && 'messages' in channel) {
      const message = await channel.messages.fetch(lootPost.message_id);
      await message.delete();
    }
  } catch (error) {
    logger.warn('Loot', `Failed to delete Discord message for boss_id ${bossId}: ${error}`);
  }

  // Delete from DB (responses first due to FK, then post)
  db.prepare('DELETE FROM loot_responses WHERE loot_post_id = ?').run(lootPost.id);
  db.prepare('DELETE FROM loot_posts WHERE boss_id = ?').run(bossId);

  logger.info('Loot', `Deleted loot post for boss_id ${bossId} (post_id=${lootPost.id})`);
}

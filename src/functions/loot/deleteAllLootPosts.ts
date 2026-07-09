import type { Client } from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';
import { deleteLootPost } from './deleteLootPost.js';

/**
 * Delete every loot post — Discord message and DB rows — by delegating to
 * deleteLootPost for each boss. Returns the number of posts deleted.
 */
export async function deleteAllLootPosts(client: Client): Promise<number> {
  const db = getDatabase();
  const rows = db.prepare('SELECT boss_id FROM loot_posts ORDER BY boss_id').all() as {
    boss_id: number;
  }[];

  let deleted = 0;
  for (const { boss_id } of rows) {
    try {
      await deleteLootPost(client, boss_id);
      deleted++;
    } catch (error) {
      logger.warn('Loot', `Failed to delete loot post for boss ${boss_id}: ${error}`);
    }
  }

  logger.info('Loot', `Deleted ${deleted}/${rows.length} loot posts`);
  return deleted;
}

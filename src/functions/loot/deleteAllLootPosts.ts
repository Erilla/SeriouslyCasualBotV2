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
  const rows = db.prepare('SELECT boss_id FROM loot_posts ORDER BY boss_id').all() as { boss_id: number }[];

  for (const { boss_id } of rows) {
    await deleteLootPost(client, boss_id);
  }

  logger.info('Loot', `Deleted all loot posts (${rows.length})`);
  return rows.length;
}

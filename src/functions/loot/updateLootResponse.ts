import type { Client } from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';
import { updateLootPost } from './updateLootPost.js';
import type { LootPostRow } from '../../types/index.js';

export async function updateLootResponse(
  client: Client,
  responseType: string,
  bossId: number,
  userId: string,
): Promise<string> {
  const db = getDatabase();

  const lootPost = db
    .prepare('SELECT * FROM loot_posts WHERE boss_id = ?')
    .get(bossId) as LootPostRow | undefined;

  if (!lootPost) {
    logger.warn('Loot', `No loot post found for boss_id ${bossId}`);
    return '';
  }

  const txn = db.transaction(() => {
    db.prepare('DELETE FROM loot_responses WHERE loot_post_id = ? AND user_id = ?')
      .run(lootPost.id, userId);

    db.prepare('INSERT INTO loot_responses (loot_post_id, user_id, response_type) VALUES (?, ?, ?)')
      .run(lootPost.id, userId, responseType);
  });

  txn();

  await updateLootPost(client, bossId);

  return '';
}

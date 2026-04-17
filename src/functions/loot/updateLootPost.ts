import type { Client } from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';
import { generateLootPost } from './generateLootPost.js';
import type { LootPostRow, LootResponseRow, RaiderRow } from '../../types/index.js';

export async function updateLootPost(client: Client, bossId: number): Promise<void> {
  const db = getDatabase();

  const lootPost = db
    .prepare('SELECT * FROM loot_posts WHERE boss_id = ?')
    .get(bossId) as LootPostRow | undefined;

  if (!lootPost) {
    logger.warn('Loot', `No loot post found for boss_id ${bossId}`);
    return;
  }

  const responses = db
    .prepare('SELECT * FROM loot_responses WHERE loot_post_id = ?')
    .all(lootPost.id) as LootResponseRow[];

  const raiders = db
    .prepare('SELECT * FROM raiders WHERE discord_user_id IS NOT NULL')
    .all() as RaiderRow[];

  const userToCharacter = new Map<string, string>();
  for (const raider of raiders) {
    if (raider.discord_user_id && !userToCharacter.has(raider.discord_user_id)) {
      userToCharacter.set(raider.discord_user_id, raider.character_name);
    }
  }

  const grouped: Record<string, string[]> = {
    major: [],
    minor: [],
    wantIn: [],
    wantOut: [],
  };

  for (const response of responses) {
    const charName = userToCharacter.get(response.user_id) ?? 'Unknown';
    if (grouped[response.response_type]) {
      grouped[response.response_type].push(charName);
    }
  }

  const playerResponses = {
    major: grouped.major.length > 0 ? grouped.major.join('\n') : '*None*',
    minor: grouped.minor.length > 0 ? grouped.minor.join('\n') : '*None*',
    wantIn: grouped.wantIn.length > 0 ? grouped.wantIn.join('\n') : '*None*',
    wantOut: grouped.wantOut.length > 0 ? grouped.wantOut.join('\n') : '*None*',
  };

  const postData = generateLootPost(lootPost.boss_name, bossId, playerResponses);

  try {
    const channel = await client.channels.fetch(lootPost.channel_id);
    if (!channel || !('messages' in channel)) {
      logger.warn('Loot', `Channel ${lootPost.channel_id} not found or not a text channel`);
      return;
    }

    const message = await channel.messages.fetch(lootPost.message_id);
    await message.edit(postData);
  } catch (error) {
    logger.error('Loot', `Failed to update loot post for boss_id ${bossId}`, error as Error);
  }
}

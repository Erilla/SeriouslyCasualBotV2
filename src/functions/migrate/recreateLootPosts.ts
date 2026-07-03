import { ChannelType, type Client, type TextChannel } from 'discord.js';
import type Database from 'better-sqlite3';
import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';
import { config } from '../../config.js';
import { getOrCreateChannel } from '../channels.js';
import { addLootPost } from '../loot/addLootPost.js';
import { updateLootPost } from '../loot/updateLootPost.js';
import type { V1LootPost, V1Votes } from './parseV1Export.js';
import type { LootPostRow } from '../../types/index.js';

const RESPONSE_TYPES: (keyof V1Votes)[] = ['major', 'minor', 'wantIn', 'wantOut'];

export function insertLootResponses(db: Database.Database, lootPostId: number, votes: V1Votes): number {
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO loot_responses (loot_post_id, user_id, response_type) VALUES (?, ?, ?)',
  );
  let inserted = 0;
  for (const type of RESPONSE_TYPES) {
    for (const userId of votes[type]) {
      inserted += stmt.run(lootPostId, userId, type).changes;
    }
  }
  return inserted;
}

export interface LootRecreateResult { created: number; skipped: number; failed: number }

export async function recreateLootPosts(
  client: Client,
  lootPosts: V1LootPost[],
): Promise<LootRecreateResult> {
  const db = getDatabase();
  const result: LootRecreateResult = { created: 0, skipped: 0, failed: 0 };
  if (lootPosts.length === 0) return result;

  const guild = await client.guilds.fetch(config.guildId);
  const channel = (await getOrCreateChannel(guild, {
    name: 'loot',
    type: ChannelType.GuildText,
    categoryName: 'Raiders',
    configKey: 'loot_channel_id',
  })) as TextChannel;

  for (const post of lootPosts) {
    const existing = db.prepare('SELECT id FROM loot_posts WHERE boss_id = ?').get(post.bossId);
    if (existing) {
      result.skipped++;
      continue;
    }
    try {
      await addLootPost(channel, { id: post.bossId, name: post.bossName, url: post.bossUrl ?? undefined });
      const row = db.prepare('SELECT * FROM loot_posts WHERE boss_id = ?').get(post.bossId) as LootPostRow | undefined;
      if (!row) throw new Error(`loot_posts row missing after addLootPost for boss ${post.bossId}`);
      insertLootResponses(db, row.id, post.votes);
      await updateLootPost(client, post.bossId);
      result.created++;
    } catch (error) {
      result.failed++;
      logger.error('Migrate', `Failed to recreate loot post for boss ${post.bossId}`, error as Error);
    }
  }

  return result;
}

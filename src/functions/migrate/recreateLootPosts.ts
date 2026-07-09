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

export function insertLootResponses(
  db: Database.Database,
  lootPostId: number,
  votes: V1Votes,
): number {
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO loot_responses (loot_post_id, user_id, response_type) VALUES (?, ?, ?)',
  );
  let inserted = 0;
  // A user can only hold one loot_responses row per post (UNIQUE(loot_post_id, user_id)).
  // We iterate RESPONSE_TYPES in priority order (major → minor → wantIn → wantOut) and
  // INSERT OR IGNORE, so a V1 voter who appears in multiple categories collapses to their
  // highest-priority category by design.
  for (const type of RESPONSE_TYPES) {
    for (const userId of votes[type]) {
      inserted += stmt.run(lootPostId, userId, type).changes;
    }
  }
  return inserted;
}

export interface LootRecreateResult {
  created: number;
  merged: number;
  failed: number;
}

export async function recreateLootPosts(
  client: Client,
  lootPosts: V1LootPost[],
): Promise<LootRecreateResult> {
  const db = getDatabase();
  const result: LootRecreateResult = { created: 0, merged: 0, failed: 0 };
  if (lootPosts.length === 0) return result;

  let channel: TextChannel;
  try {
    const guild = await client.guilds.fetch(config.guildId);
    channel = (await getOrCreateChannel(guild, {
      name: 'loot',
      type: ChannelType.GuildText,
      categoryName: 'Raiders',
      configKey: 'loot_channel_id',
    })) as TextChannel;
  } catch (error) {
    logger.error('Migrate', 'Failed to resolve loot channel', error as Error);
    return { created: 0, merged: 0, failed: lootPosts.length };
  }

  const stmtFetch = db.prepare('SELECT * FROM loot_posts WHERE boss_id = ?');

  for (const post of lootPosts) {
    try {
      let row = stmtFetch.get(post.bossId) as LootPostRow | undefined;
      const alreadyExisted = row !== undefined;

      if (!row) {
        await addLootPost(channel, {
          id: post.bossId,
          name: post.bossName,
          url: post.bossUrl ?? undefined,
        });
        row = stmtFetch.get(post.bossId) as LootPostRow | undefined;
        if (!row)
          throw new Error(`loot_posts row missing after addLootPost for boss ${post.bossId}`);
      }

      insertLootResponses(db, row.id, post.votes);
      await updateLootPost(client, post.bossId);

      if (alreadyExisted) result.merged++;
      else result.created++;
    } catch (error) {
      result.failed++;
      logger.error(
        'Migrate',
        `Failed to recreate loot post for boss ${post.bossId}`,
        error as Error,
      );
    }
  }

  return result;
}

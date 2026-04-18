import type { Client, TextChannel } from 'discord.js';
import { ChannelType } from 'discord.js';
import type Database from 'better-sqlite3';
import { logger } from '../../../services/logger.js';
import { addLootPost, type Boss } from '../../loot/addLootPost.js';

const MOCK_BOSSES: Boss[] = [
  { id: 99901, name: 'Mock Boss Alpha', url: 'https://www.wowhead.com/npc/99901/mock-boss-alpha' },
  { id: 99902, name: 'Mock Boss Beta',  url: 'https://www.wowhead.com/npc/99902/mock-boss-beta' },
  { id: 99903, name: 'Mock Boss Gamma' },
];

export interface SeedLootDiscordResult {
  postsAttempted: number;
  postsCreated: number;
  skippedReason?: string;
}

/**
 * Posts 3 mock loot-post messages to the configured loot channel. Each call to addLootPost
 * inserts a row into loot_posts with the real channel_id and message_id. Skips the whole
 * operation gracefully if loot_channel_id is not configured.
 */
export async function seedLootDiscord(
  client: Client,
  db: Database.Database,
): Promise<SeedLootDiscordResult> {
  const row = db
    .prepare('SELECT value FROM config WHERE key = ?')
    .get('loot_channel_id') as { value: string } | undefined;

  if (!row) {
    return {
      postsAttempted: 0,
      postsCreated: 0,
      skippedReason: 'loot_channel_id not configured — run /setup set_channel key:loot_channel_id first',
    };
  }

  let channel: TextChannel;
  try {
    const fetched = await client.channels.fetch(row.value);
    if (!fetched || fetched.type !== ChannelType.GuildText) {
      return {
        postsAttempted: 0,
        postsCreated: 0,
        skippedReason: 'loot_channel_id points to a non-text channel',
      };
    }
    channel = fetched as TextChannel;
  } catch (error) {
    return {
      postsAttempted: 0,
      postsCreated: 0,
      skippedReason: `could not fetch loot channel: ${(error as Error).message}`,
    };
  }

  let created = 0;
  for (const boss of MOCK_BOSSES) {
    const existing = db.prepare('SELECT id FROM loot_posts WHERE boss_id = ?').get(boss.id);
    if (existing) continue;
    try {
      await addLootPost(channel, boss);
      created++;
    } catch (error) {
      logger.warn('TestData', `Failed to post loot for boss ${boss.id}: ${(error as Error).message}`);
    }
  }

  return { postsAttempted: MOCK_BOSSES.length, postsCreated: created };
}

import type { Client, TextChannel } from 'discord.js';
import { ChannelType } from 'discord.js';
import type Database from 'better-sqlite3';
import { logger } from '../../../services/logger.js';
import { seedLoot } from '../seedLoot.js';
import { addLootPost, type Boss } from '../../loot/addLootPost.js';

const MOCK_BOSSES: Boss[] = [
  { id: 99901, name: 'Mock Boss Alpha', url: 'https://www.wowhead.com/npc/99901/mock-boss-alpha' },
  { id: 99902, name: 'Mock Boss Beta',  url: 'https://www.wowhead.com/npc/99902/mock-boss-beta' },
  { id: 99903, name: 'Mock Boss Gamma' },
];

export interface SeedLootDiscordResult {
  dbPostsInserted: number;
  postsAttempted: number;
  postsCreated: number;
  skippedReason?: string;
}

/**
 * Seeds DB loot_posts rows (via seedLoot), then — if loot_channel_id is configured — also
 * posts the 3 mock bosses to the channel and updates loot_posts with real channel/message IDs.
 * If the channel isn't configured or can't be fetched, the DB rows remain (with placeholder
 * channel/message IDs) and skippedReason is set.
 */
export async function seedLootDiscord(
  client: Client,
  db: Database.Database,
): Promise<SeedLootDiscordResult> {
  const dbResult = seedLoot(db);

  const row = db
    .prepare('SELECT value FROM config WHERE key = ?')
    .get('loot_channel_id') as { value: string } | undefined;

  if (!row) {
    return {
      dbPostsInserted: dbResult.postsInserted,
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
        dbPostsInserted: dbResult.postsInserted,
        postsAttempted: 0,
        postsCreated: 0,
        skippedReason: 'loot_channel_id points to a non-text channel',
      };
    }
    channel = fetched as TextChannel;
  } catch (error) {
    return {
      dbPostsInserted: dbResult.postsInserted,
      postsAttempted: 0,
      postsCreated: 0,
      skippedReason: `could not fetch loot channel: ${(error as Error).message}`,
    };
  }

  // For Discord variant we want real message IDs. Replace the placeholder DB rows that seedLoot
  // just inserted with real ones by deleting them first, then calling addLootPost per boss.
  const deleteStmt = db.prepare('DELETE FROM loot_posts WHERE boss_id = ?');
  for (const boss of MOCK_BOSSES) {
    deleteStmt.run(boss.id);
  }

  let created = 0;
  for (const boss of MOCK_BOSSES) {
    try {
      await addLootPost(channel, boss);
      created++;
    } catch (error) {
      logger.warn('TestData', `Failed to post loot for boss ${boss.id}: ${(error as Error).message}`);
    }
  }

  return {
    dbPostsInserted: dbResult.postsInserted,
    postsAttempted: MOCK_BOSSES.length,
    postsCreated: created,
  };
}

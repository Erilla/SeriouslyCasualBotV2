import type Database from 'better-sqlite3';

export interface SeedLootResult {
  postsInserted: number;
}

const MOCK_LOOT_POSTS = [
  {
    boss_id: 99901,
    boss_name: 'Mock Boss Alpha',
    boss_url: 'https://www.wowhead.com/npc/99901/mock-boss-alpha',
    channel_id: 'mock-channel-id',
    message_id: 'mock-message-id-1',
  },
  {
    boss_id: 99902,
    boss_name: 'Mock Boss Beta',
    boss_url: 'https://www.wowhead.com/npc/99902/mock-boss-beta',
    channel_id: 'mock-channel-id',
    message_id: 'mock-message-id-2',
  },
  {
    boss_id: 99903,
    boss_name: 'Mock Boss Gamma',
    boss_url: null,
    channel_id: 'mock-channel-id',
    message_id: 'mock-message-id-3',
  },
];

/**
 * Seeds 3 mock loot_posts with unique boss_ids (99901–99903).
 * Idempotent: uses INSERT OR IGNORE.
 */
export function seedLoot(db: Database.Database): SeedLootResult {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO loot_posts (boss_id, boss_name, boss_url, channel_id, message_id)
    VALUES (@boss_id, @boss_name, @boss_url, @channel_id, @message_id)
  `);

  const insertMany = db.transaction((): SeedLootResult => {
    let inserted = 0;
    for (const post of MOCK_LOOT_POSTS) {
      const result = insert.run(post);
      if (result.changes > 0) inserted++;
    }
    return { postsInserted: inserted };
  });

  return insertMany();
}

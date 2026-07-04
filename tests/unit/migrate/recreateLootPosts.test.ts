import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTables } from '../../../src/database/schema.js';

// config.js throws at import if env vars are unset — mock it (no global env in unit tests).
vi.mock('../../../src/config.js', () => ({ config: { guildId: 'guild-1' } }));

// addLootPost mock inserts the loot_posts row into the shared in-memory DB,
// mirroring the real implementation, so the response-insert step can find it.
vi.mock('../../../src/functions/loot/addLootPost.js', () => ({
  addLootPost: vi.fn(async (_channel: unknown, boss: { id: number; name: string; url?: string }) => {
    const { getDatabase } = await import('../../../src/database/db.js');
    getDatabase()
      .prepare('INSERT INTO loot_posts (boss_id, boss_name, boss_url, channel_id, message_id) VALUES (?, ?, ?, ?, ?)')
      .run(boss.id, boss.name, boss.url ?? null, 'chan', `msg${boss.id}`);
  }),
}));
vi.mock('../../../src/functions/loot/updateLootPost.js', () => ({ updateLootPost: vi.fn(async () => {}) }));
vi.mock('../../../src/functions/channels.js', () => ({ getOrCreateChannel: vi.fn(async () => ({ id: 'loot-chan' })) }));

import { getDatabase, closeDatabase } from '../../../src/database/db.js';
import { addLootPost } from '../../../src/functions/loot/addLootPost.js';
import { insertLootResponses, recreateLootPosts } from '../../../src/functions/migrate/recreateLootPosts.js';

const post = {
  bossId: 197140,
  bossName: 'Midnight Falls',
  bossUrl: 'https://x/mf',
  votes: { major: ['u1', 'u2'], minor: ['u3'], wantIn: [], wantOut: ['u4'] },
};

beforeEach(() => {
  closeDatabase();
  createTables(getDatabase(':memory:'));
});

describe('insertLootResponses', () => {
  it('inserts one row per user per response type', () => {
    const db = getDatabase();
    db.prepare('INSERT INTO loot_posts (boss_id, boss_name, boss_url, channel_id, message_id) VALUES (?,?,?,?,?)')
      .run(1, 'B', null, 'c', 'm');
    const lootPostId = (db.prepare('SELECT id FROM loot_posts WHERE boss_id = 1').get() as { id: number }).id;

    const n = insertLootResponses(db, lootPostId, post.votes);
    expect(n).toBe(4);
    const rows = db.prepare('SELECT user_id, response_type FROM loot_responses ORDER BY user_id').all();
    expect(rows).toEqual([
      { user_id: 'u1', response_type: 'major' },
      { user_id: 'u2', response_type: 'major' },
      { user_id: 'u3', response_type: 'minor' },
      { user_id: 'u4', response_type: 'wantOut' },
    ]);
  });
});

describe('recreateLootPosts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates a post + responses on first run, then merges votes into the existing post on re-run', async () => {
    const client = { guilds: { fetch: vi.fn(async () => ({ id: 'guild-1' })) } } as never;

    const first = await recreateLootPosts(client, [post]);
    expect(first).toEqual({ created: 1, merged: 0, failed: 0 });
    expect(getDatabase().prepare('SELECT COUNT(*) c FROM loot_responses').get()).toEqual({ c: 4 });

    // Re-run: post already exists → votes merged, no new post, INSERT OR IGNORE keeps count at 4.
    const second = await recreateLootPosts(client, [post]);
    expect(second).toEqual({ created: 0, merged: 1, failed: 0 });
    expect(getDatabase().prepare('SELECT COUNT(*) c FROM loot_responses').get()).toEqual({ c: 4 });
  });

  it('merges votes into a post that already existed (e.g. created by /loot create_posts) without creating a duplicate', async () => {
    const client = { guilds: { fetch: vi.fn(async () => ({ id: 'guild-1' })) } } as never;
    const { addLootPost } = await import('../../../src/functions/loot/addLootPost.js');

    // Simulate a pre-existing post created by the normal loot flow.
    getDatabase()
      .prepare('INSERT INTO loot_posts (boss_id, boss_name, boss_url, channel_id, message_id) VALUES (?, ?, ?, ?, ?)')
      .run(post.bossId, post.bossName, post.bossUrl, 'preexisting-chan', 'preexisting-msg');

    const result = await recreateLootPosts(client, [post]);

    expect(result).toEqual({ created: 0, merged: 1, failed: 0 });
    expect(vi.mocked(addLootPost)).not.toHaveBeenCalled();      // no duplicate post
    expect(getDatabase().prepare('SELECT COUNT(*) c FROM loot_responses').get()).toEqual({ c: 4 });
    // votes attached to the pre-existing post, not a new one
    const only = getDatabase().prepare('SELECT COUNT(*) c FROM loot_posts WHERE boss_id = ?').get(post.bossId);
    expect(only).toEqual({ c: 1 });
  });

  it('isolates a per-post failure and still processes the rest', async () => {
    const client = { guilds: { fetch: vi.fn(async () => ({ id: 'guild-1' })) } } as never;
    const { addLootPost } = await import('../../../src/functions/loot/addLootPost.js');
    vi.mocked(addLootPost).mockRejectedValueOnce(new Error('discord fail'));

    const postB = { ...post, bossId: 197139, bossName: "Belo'ren, Child of Al'ar" };
    const result = await recreateLootPosts(client, [post, postB]);

    expect(result).toEqual({ created: 1, merged: 0, failed: 1 });
    // the boss that failed created no loot_posts row
    expect(getDatabase().prepare('SELECT COUNT(*) c FROM loot_posts WHERE boss_id = ?').get(post.bossId)).toEqual({ c: 0 });
  });
});

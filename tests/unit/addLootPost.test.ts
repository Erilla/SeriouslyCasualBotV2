import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, getDatabase } from '../../src/database/db.js';
import { createTables } from '../../src/database/schema.js';

vi.mock('../../src/services/logger.js', () => ({
  logger: { debug: vi.fn() },
}));

const { addLootPost } = await import('../../src/functions/loot/addLootPost.js');

beforeEach(() => {
  closeDatabase();
  createTables(getDatabase(':memory:'));
});

afterEach(() => {
  closeDatabase();
});

describe('addLootPost', () => {
  it('reuses an existing boss post without sending a duplicate or losing its votes', async () => {
    const db = getDatabase();
    db.prepare(
      'INSERT INTO loot_posts (boss_id, boss_name, boss_url, channel_id, message_id) VALUES (?, ?, ?, ?, ?)',
    ).run(197188, 'Nymrissa Wavecaller', null, 'loot-channel', 'existing-message');
    const post = db.prepare('SELECT id FROM loot_posts WHERE boss_id = ?').get(197188) as {
      id: number;
    };
    db.prepare(
      'INSERT INTO loot_responses (loot_post_id, user_id, response_type) VALUES (?, ?, ?)',
    ).run(post.id, 'raider-1', 'major');
    const channel = {
      id: 'loot-channel',
      messages: { fetch: vi.fn(async () => ({ id: 'existing-message' })) },
      send: vi.fn(async () => ({ id: 'duplicate-message' })),
    };

    await addLootPost(channel as never, { id: 197188, name: 'Nymrissa Wavecaller' });

    expect(channel.send).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS count FROM loot_posts').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT user_id, response_type FROM loot_responses').all()).toEqual([
      { user_id: 'raider-1', response_type: 'major' },
    ]);
  });

  it('recreates a missing tracked message while preserving the boss post and its votes', async () => {
    const db = getDatabase();
    db.prepare(
      'INSERT INTO loot_posts (boss_id, boss_name, boss_url, channel_id, message_id) VALUES (?, ?, ?, ?, ?)',
    ).run(197188, 'Nymrissa Wavecaller', null, 'loot-channel', 'missing-message');
    const post = db.prepare('SELECT id FROM loot_posts WHERE boss_id = ?').get(197188) as {
      id: number;
    };
    db.prepare(
      'INSERT INTO loot_responses (loot_post_id, user_id, response_type) VALUES (?, ?, ?)',
    ).run(post.id, 'raider-1', 'major');
    const channel = {
      id: 'loot-channel',
      messages: { fetch: vi.fn(async () => Promise.reject(new Error('Unknown Message'))) },
      send: vi.fn(async () => ({ id: 'replacement-message' })),
    };

    await addLootPost(channel as never, { id: 197188, name: 'Nymrissa Wavecaller' });

    expect(channel.send).toHaveBeenCalledOnce();
    expect(db.prepare('SELECT message_id FROM loot_posts WHERE boss_id = ?').get(197188)).toEqual({
      message_id: 'replacement-message',
    });
    expect(db.prepare('SELECT user_id, response_type FROM loot_responses').all()).toEqual([
      { user_id: 'raider-1', response_type: 'major' },
    ]);
  });
});

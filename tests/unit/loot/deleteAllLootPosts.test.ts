import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTables } from '../../../src/database/schema.js';

vi.mock('../../../src/functions/loot/deleteLootPost.js', () => ({ deleteLootPost: vi.fn(async () => {}) }));

import { getDatabase, closeDatabase } from '../../../src/database/db.js';
import { deleteLootPost } from '../../../src/functions/loot/deleteLootPost.js';
import { deleteAllLootPosts } from '../../../src/functions/loot/deleteAllLootPosts.js';

beforeEach(() => {
  closeDatabase();
  createTables(getDatabase(':memory:'));
  vi.clearAllMocks();
});

describe('deleteAllLootPosts', () => {
  it('calls deleteLootPost for every loot post and returns the count', async () => {
    const db = getDatabase();
    const insert = db.prepare('INSERT INTO loot_posts (boss_id, boss_name, boss_url, channel_id, message_id) VALUES (?, ?, ?, ?, ?)');
    insert.run(101, 'A', null, 'c', 'm1');
    insert.run(202, 'B', null, 'c', 'm2');

    const client = {} as never;
    const count = await deleteAllLootPosts(client);

    expect(count).toBe(2);
    expect(vi.mocked(deleteLootPost)).toHaveBeenCalledTimes(2);
    const calledBossIds = vi.mocked(deleteLootPost).mock.calls.map((c) => c[1]).sort();
    expect(calledBossIds).toEqual([101, 202]);
  });

  it('returns 0 and calls nothing when there are no loot posts', async () => {
    const count = await deleteAllLootPosts({} as never);
    expect(count).toBe(0);
    expect(vi.mocked(deleteLootPost)).not.toHaveBeenCalled();
  });

  it('isolates a per-item failure and counts only successful deletes', async () => {
    const db = getDatabase();
    const insert = db.prepare('INSERT INTO loot_posts (boss_id, boss_name, boss_url, channel_id, message_id) VALUES (?, ?, ?, ?, ?)');
    insert.run(101, 'A', null, 'c', 'm1');
    insert.run(202, 'B', null, 'c', 'm2');

    vi.mocked(deleteLootPost).mockRejectedValueOnce(new Error('discord fail'));

    const client = {} as never;
    const count = await deleteAllLootPosts(client);

    expect(count).toBe(1);
    expect(vi.mocked(deleteLootPost)).toHaveBeenCalledTimes(2);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType, type CategoryChannel, type Guild } from 'discord.js';
import { closeDatabase, getDatabase } from '../../src/database/db.js';
import { createTables } from '../../src/database/schema.js';

vi.mock('../../src/services/logger.js', () => ({
  logger: {
    warn: vi.fn(),
  },
}));

import {
  refreshPendingApplicationCategory,
  resolveApplicationLogCategory,
} from '../../src/functions/applications/applicationLogCategory.js';
import { logger } from '../../src/services/logger.js';

type MockCategory = Pick<CategoryChannel, 'id' | 'name' | 'type' | 'setName'>;

function makeCategory({ id, name }: { id: string; name: string }): MockCategory {
  return {
    id,
    name,
    type: ChannelType.GuildCategory,
    setName: vi.fn(async () => undefined),
  };
}

function makeGuild(categories: MockCategory[]): Guild {
  const channels = new Map(categories.map((category) => [category.id, category]));
  return {
    id: 'guild-1',
    channels: {
      cache: {
        get: (id: string) => channels.get(id),
        values: () => channels.values(),
      },
      fetch: vi.fn(async (id: string) => channels.get(id) ?? null),
    },
  } as unknown as Guild;
}

function seedConfig(key: string, value: string): void {
  getDatabase().prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, value);
}

function readConfig(key: string): string | undefined {
  return (
    getDatabase().prepare('SELECT value FROM config WHERE key = ?').get(key) as
      | { value: string }
      | undefined
  )?.value;
}

function seedApplication(status: string): void {
  getDatabase()
    .prepare('INSERT INTO applications (applicant_user_id, status) VALUES (?, ?)')
    .run(crypto.randomUUID(), status);
}

beforeEach(() => {
  closeDatabase();
  createTables(getDatabase(':memory:'));
  vi.clearAllMocks();
});

afterEach(() => {
  closeDatabase();
});

describe('application log category', () => {
  it('uses the stored category ID and counts only active applications', async () => {
    seedConfig('application_log_category_id', 'category-1');
    seedApplication('active');
    seedApplication('active');
    seedApplication('in_progress');
    seedApplication('accepted');
    const category = makeCategory({ id: 'category-1', name: 'Application-logs' });

    await refreshPendingApplicationCategory(makeGuild([category]));

    expect(category.setName).toHaveBeenCalledWith('APPLICATION LOGS · 2 PENDING');
  });

  it('discovers and persists the legacy-named category when no ID is stored', async () => {
    const category = makeCategory({ id: 'category-1', name: 'Application-logs' });

    await expect(resolveApplicationLogCategory(makeGuild([category]))).resolves.toBe(category);

    expect(readConfig('application_log_category_id')).toBe('category-1');
  });

  it('does not rename a category that already displays the current count', async () => {
    const category = makeCategory({ id: 'category-1', name: 'APPLICATION LOGS · 0 PENDING' });
    seedConfig('application_log_category_id', 'category-1');

    await refreshPendingApplicationCategory(makeGuild([category]));

    expect(category.setName).not.toHaveBeenCalled();
  });

  it('warns and resolves when the category cannot be found or Discord rejects the rename', async () => {
    await expect(refreshPendingApplicationCategory(makeGuild([]))).resolves.toBeUndefined();

    const category = makeCategory({ id: 'category-1', name: 'Application-logs' });
    category.setName.mockRejectedValueOnce(new Error('Missing Permissions'));
    await expect(refreshPendingApplicationCategory(makeGuild([category]))).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('clears a stale stored ID before discovering a current-format category', async () => {
    seedConfig('application_log_category_id', 'missing-category');
    const category = makeCategory({ id: 'category-2', name: 'APPLICATION LOGS · 3 PENDING' });

    await expect(resolveApplicationLogCategory(makeGuild([category]))).resolves.toBe(category);

    expect(readConfig('application_log_category_id')).toBe('category-2');
  });
});

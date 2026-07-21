import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Client } from 'discord.js';
import { getDatabase, closeDatabase } from '../../src/database/db.js';
import { createTables } from '../../src/database/schema.js';

vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { rescheduleAllAlerts } from '../../src/functions/trial-review/scheduleTrialAlerts.js';
import { resumeSessions } from '../../src/functions/applications/resumeSessions.js';
import { logger } from '../../src/services/logger.js';

const client = {} as unknown as Client;

beforeEach(() => {
  closeDatabase();
  createTables(getDatabase(':memory:'));
  vi.clearAllMocks();
});

afterEach(() => {
  closeDatabase();
});

describe('rescheduleAllAlerts — startup stats', () => {
  it('returns zero counts on an empty database and logs at DEBUG, not INFO', () => {
    const stats = rescheduleAllAlerts(client);

    expect(stats).toEqual({
      pastDue: 0,
      scheduled: 0,
      promotePastDue: 0,
      promoteScheduled: 0,
    });
    expect(logger.debug).toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });
});

describe('resumeSessions — startup stats', () => {
  it('returns 0 with no in-progress sessions and logs at DEBUG, not INFO', async () => {
    await expect(resumeSessions(client)).resolves.toBe(0);

    expect(logger.debug).toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Client, User } from 'discord.js';
import { getDatabase, closeDatabase } from '../../src/database/db.js';
import { createTables } from '../../src/database/schema.js';

vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { rescheduleAllAlerts } from '../../src/functions/trial-review/scheduleTrialAlerts.js';
import { resumeSessions } from '../../src/functions/applications/resumeSessions.js';
import { activeSessions } from '../../src/functions/applications/dmQuestionnaire.js';
import { logger } from '../../src/services/logger.js';

const client = {} as unknown as Client;

beforeEach(() => {
  closeDatabase();
  createTables(getDatabase(':memory:'));
  vi.clearAllMocks();
});

afterEach(() => {
  // Belt-and-braces: any test that switches to fake timers (e.g. to keep
  // safeSetTimeout/startSessionTimeout from creating real pending timers)
  // must not leak fake state into the next test. Calling this when timers
  // are already real is a no-op.
  vi.useRealTimers();
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

  it('returns scheduled: 1 for a single future-dated trial alert', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-01T00:00:00Z'));

    const db = getDatabase();
    // trials.application_id is nullable, so a bare trials row is enough to
    // satisfy trial_alerts' FK without also seeding an applications row.
    const trialId = db
      .prepare(`INSERT INTO trials (character_name, role, start_date) VALUES (?, ?, ?)`)
      .run('Testchar', 'dps', '2026-06-01').lastInsertRowid as number;
    db.prepare(
      `INSERT INTO trial_alerts (trial_id, alert_name, alert_date, alerted) VALUES (?, ?, ?, 0)`,
    ).run(trialId, '7_day', '2026-08-01');

    const stats = rescheduleAllAlerts(client);

    expect(stats).toEqual({
      pastDue: 0,
      scheduled: 1,
      promotePastDue: 0,
      promoteScheduled: 0,
    });
  });
});

describe('resumeSessions — startup stats', () => {
  it('returns 0 with no in-progress sessions and logs at DEBUG, not INFO', async () => {
    await expect(resumeSessions(client)).resolves.toBe(0);

    expect(logger.debug).toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('resolves to 1 when one in-progress application is successfully resumed', async () => {
    // Fake timers so startSessionTimeout's 30-minute setTimeout doesn't leave
    // a real pending timer behind; the shared afterEach restores real timers.
    vi.useFakeTimers();

    const db = getDatabase();
    db.prepare(`INSERT INTO application_questions (question, sort_order) VALUES (?, ?)`).run(
      'Why do you want to join?',
      0,
    );
    db.prepare(
      `INSERT INTO applications (applicant_user_id, status) VALUES (?, 'in_progress')`,
    ).run('user-123');

    const send = vi.fn().mockResolvedValue(undefined);
    const fakeUser = { id: 'user-123', tag: 'Tester#0001', send } as unknown as User;
    const fakeClient = {
      users: { fetch: vi.fn().mockResolvedValue(fakeUser) },
    } as unknown as Client;

    try {
      await expect(resumeSessions(fakeClient)).resolves.toBe(1);
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      // activeSessions is module-global state, not reset by beforeEach/
      // closeDatabase — clear it so this session can't leak into other tests.
      activeSessions.delete('user-123');
    }
  });
});

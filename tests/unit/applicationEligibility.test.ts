import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { GuildMember, User } from 'discord.js';
import { closeDatabase, getDatabase } from '../../src/database/db.js';
import { createTables } from '../../src/database/schema.js';

vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { startApplication } from '../../src/functions/applications/startApplication.js';
import { activeSessions } from '../../src/functions/applications/dmQuestionnaire.js';

const RAIDER_ROLE_ID = 'role-raider';

function fakeUser(id = 'applicant-1'): User {
  return {
    id,
    displayName: 'TestCharacter',
    tag: 'TestCharacter#0001',
    send: vi.fn().mockResolvedValue(undefined),
  } as unknown as User;
}

/** Guild member stand-in whose role cache holds exactly `roleIds`. */
function fakeMember(roleIds: string[]): GuildMember {
  return { roles: { cache: new Map(roleIds.map((id) => [id, { id }])) } } as unknown as GuildMember;
}

function seedApplication(status: string, resolvedAt: string | null = null): number {
  return Number(
    getDatabase()
      .prepare('INSERT INTO applications (applicant_user_id, status, resolved_at) VALUES (?, ?, ?)')
      .run('applicant-1', status, resolvedAt).lastInsertRowid,
  );
}

function countApplications(): number {
  return (getDatabase().prepare('SELECT COUNT(*) AS n FROM applications').get() as { n: number }).n;
}

beforeEach(() => {
  closeDatabase();
  const db = getDatabase(':memory:');
  createTables(db);
  db.prepare('INSERT INTO application_questions (question, sort_order) VALUES (?, ?)').run(
    'What class are you applying as?',
    1,
  );
  db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(
    'raider_role_id',
    RAIDER_ROLE_ID,
  );
  vi.clearAllMocks();
});

afterEach(() => {
  activeSessions.clear();
  closeDatabase();
});

describe('startApplication eligibility', () => {
  it('starts an application for an eligible applicant', async () => {
    const user = fakeUser();

    const result = await startApplication(user, fakeMember([]));

    expect(result.outcome).toBe('started');
    expect(user.send).toHaveBeenCalled();
    expect(countApplications()).toBe(1);
  });

  it('refuses an applicant who already has the raider role', async () => {
    const user = fakeUser();

    const result = await startApplication(user, fakeMember([RAIDER_ROLE_ID]));

    expect(result).toMatchObject({ outcome: 'refused', reason: 'already_raider' });
    expect(countApplications()).toBe(0);
    expect(user.send).not.toHaveBeenCalled();
  });

  it('still starts an application when the raider role is not configured', async () => {
    getDatabase().prepare('DELETE FROM config WHERE key = ?').run('raider_role_id');

    const result = await startApplication(fakeUser(), fakeMember(['some-other-role']));

    expect(result.outcome).toBe('started');
  });

  it('refuses a second application while one is awaiting a decision', async () => {
    // startApplication only ever guarded on 'in_progress', so a submitted
    // application awaiting officer review did not block a brand-new one.
    seedApplication('active');
    const user = fakeUser();

    const result = await startApplication(user, fakeMember([]));

    expect(result).toMatchObject({ outcome: 'refused', reason: 'application_pending' });
    expect(countApplications()).toBe(1);
  });

  it('lets a previously accepted applicant who has since left apply again', async () => {
    // Being accepted once is not a life sentence: people leave and come back.
    // Current membership is what should block, and the raider-role check is
    // what expresses that — an old accepted row on its own must not.
    seedApplication('accepted', '2026-08-01 10:00:00');

    const result = await startApplication(fakeUser(), fakeMember([]));

    expect(result.outcome).toBe('started');
    expect(countApplications()).toBe(2);
  });

  it('still refuses an accepted applicant who is currently a raider', async () => {
    seedApplication('accepted', '2026-08-01 10:00:00');

    const result = await startApplication(fakeUser(), fakeMember([RAIDER_ROLE_ID]));

    expect(result).toMatchObject({ outcome: 'refused', reason: 'already_raider' });
  });

  it('applies the rejection cooldown to someone whose older application was accepted', async () => {
    // An accepted row must not mask a more recent rejection: filtering it in
    // ahead of the cooldown query reported "already accepted" and blocked the
    // applicant permanently instead of for a week.
    seedApplication('accepted', '2026-01-01 10:00:00');
    const rejectedId = seedApplication('rejected');
    getDatabase()
      .prepare(`UPDATE applications SET resolved_at = datetime('now', '-2 days') WHERE id = ?`)
      .run(rejectedId);

    const result = await startApplication(fakeUser(), fakeMember([]));

    expect(result).toMatchObject({ outcome: 'refused', reason: 'recently_rejected' });
  });

  it('refuses a re-application within 7 days of being rejected', async () => {
    seedApplication('rejected');
    getDatabase().prepare(`UPDATE applications SET resolved_at = datetime('now', '-2 days')`).run();

    const result = await startApplication(fakeUser(), fakeMember([]));

    expect(result).toMatchObject({ outcome: 'refused', reason: 'recently_rejected' });
    expect(countApplications()).toBe(1);
  });

  it('tells a recently rejected applicant when they may apply again', async () => {
    seedApplication('rejected');
    getDatabase().prepare(`UPDATE applications SET resolved_at = datetime('now', '-2 days')`).run();

    const result = await startApplication(fakeUser(), fakeMember([]));

    // Rendered as a Discord timestamp so it lands in each reader's own timezone.
    expect(result.outcome === 'refused' && result.message).toMatch(/<t:\d+:[A-Za-z]>/);
  });

  it('allows a new application once 7 days have passed since rejection', async () => {
    seedApplication('rejected');
    getDatabase().prepare(`UPDATE applications SET resolved_at = datetime('now', '-8 days')`).run();

    const result = await startApplication(fakeUser(), fakeMember([]));

    expect(result.outcome).toBe('started');
    expect(countApplications()).toBe(2);
  });

  it('treats the boundary as elapsed exactly 7 days after rejection', async () => {
    seedApplication('rejected');
    getDatabase()
      .prepare(`UPDATE applications SET resolved_at = datetime('now', '-7 days', '-1 minute')`)
      .run();

    const result = await startApplication(fakeUser(), fakeMember([]));

    expect(result.outcome).toBe('started');
  });

  it('ignores an abandoned application entirely', async () => {
    seedApplication('abandoned');

    const result = await startApplication(fakeUser(), fakeMember([]));

    expect(result.outcome).toBe('started');
  });

  it('still resumes an in-progress application rather than refusing it', async () => {
    const user = fakeUser();
    await startApplication(user, fakeMember([]));
    vi.clearAllMocks();

    const result = await startApplication(user, fakeMember([]));

    expect(result.outcome).toBe('started');
    expect(countApplications()).toBe(1);
    expect(user.send).toHaveBeenCalledWith(expect.stringContaining('Welcome back'));
  });

  it('reports a DM failure distinctly from a refusal', async () => {
    const user = {
      ...fakeUser(),
      send: vi.fn().mockRejectedValue(new Error('DMs closed')),
    } as unknown as User;

    const result = await startApplication(user, fakeMember([]));

    expect(result.outcome).toBe('dm_failed');
  });

  it('starts an application when guild membership could not be resolved', async () => {
    // A null member must not be mistaken for "has the raider role".
    const result = await startApplication(fakeUser(), null);

    expect(result.outcome).toBe('started');
  });
});

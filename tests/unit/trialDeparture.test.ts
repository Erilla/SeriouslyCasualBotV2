import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ChannelType } from 'discord.js';
import {
  buildDepartureNotification,
  buildDepartureAuditDetail,
  TRIAL_DEPARTURE_AUDIT_TITLE,
  type DepartureFacts,
} from '../../src/functions/applications/departureNotification.js';
import { closeDatabase, getDatabase } from '../../src/database/db.js';
import { createTables } from '../../src/database/schema.js';

vi.mock('../../src/services/auditLog.js', () => ({ auditNotice: vi.fn(async () => undefined) }));
vi.mock('../../src/functions/raids/overlords.js', () => ({
  getOverlords: vi.fn(() => [{ user_id: 'o1' }]),
}));

import { auditNotice } from '../../src/services/auditLog.js';
import { notifyTrialDeparture } from '../../src/functions/trial-review/notifyTrialDeparture.js';

const trialFacts: DepartureFacts = {
  subject: 'trial',
  characterName: 'Brentpriest',
  tag: 'brent#0001',
  userId: '100000000000000001',
  reference: 'trial #4',
  closingAction: 'Close the trial to tidy it up.',
};

describe('trial departure copy', () => {
  it('pings the overlords, names the character and says how to close it', () => {
    const message = buildDepartureNotification(['o1', 'o2'], trialFacts);

    expect(message.content).toBe(
      '<@o1> <@o2>\n' +
        '**Brentpriest** <@100000000000000001> (trial) has left the server. ' +
        'Close the trial to tidy it up.',
    );
  });

  it('restricts mentions to the overlord ids, so a character name cannot ping', () => {
    const message = buildDepartureNotification(['o1'], { ...trialFacts, characterName: '@everyone' });

    expect(message.allowedMentions).toEqual({ users: ['o1'] });
  });

  it('omits the mention line entirely when no overlords are configured', () => {
    const message = buildDepartureNotification([], trialFacts);

    expect(message.content).toBe(
      '**Brentpriest** <@100000000000000001> (trial) has left the server. ' +
        'Close the trial to tidy it up.',
    );
  });

  it('carries the raw user id and the trial reference in the audit detail', () => {
    expect(buildDepartureAuditDetail(trialFacts)).toBe(
      'Brentpriest <@100000000000000001> (trial) — trial #4, user id `100000000000000001`',
    );
  });

  it('has its own audit title, so a trial departure is not filed as an applicant one', () => {
    expect(TRIAL_DEPARTURE_AUDIT_TITLE).toBe('Trial left the server');
  });
});

// ── notifyTrialDeparture ──────────────────────────────────────────────────────

/** A guild whose one thread records what was sent to it. A trial review post is a
 *  forum thread, i.e. `ChannelType.PublicThread` — the type `asSendable` narrows on. */
function fakeGuild(send: (options: unknown) => Promise<void>) {
  const thread = { id: 'THREAD', type: ChannelType.PublicThread, send };
  return {
    channels: { cache: new Map([['THREAD', thread]]), fetch: async () => thread },
  } as never;
}

function seedTrial(
  over: Partial<{
    status: string;
    userId: string | null;
    threadId: string | null;
    notifiedAt: string | null;
  }> = {},
): number {
  const { status = 'active', userId = 'u1', threadId = 'THREAD', notifiedAt = null } = over;
  return Number(
    getDatabase()
      .prepare(
        `INSERT INTO trials (character_name, role, start_date, thread_id, status, discord_user_id, departed_notified_at)
         VALUES ('Brentpriest', 'dps', '2026-08-01', ?, ?, ?, ?)`,
      )
      .run(threadId, status, userId, notifiedAt).lastInsertRowid,
  );
}

describe('notifyTrialDeparture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createTables(getDatabase(':memory:'));
  });
  afterEach(() => closeDatabase());

  it('posts to the trial thread and stamps the row exactly once', async () => {
    const trialId = seedTrial();
    const send = vi.fn(async () => undefined);

    const first = await notifyTrialDeparture(fakeGuild(send), { userId: 'u1', tag: 'brent#0001' });
    const second = await notifyTrialDeparture(fakeGuild(send), { userId: 'u1', tag: 'brent#0001' });

    expect(first).toBe('notified');
    expect(second).toBe('no_trial');
    expect(send).toHaveBeenCalledOnce();
    const row = getDatabase()
      .prepare('SELECT departed_notified_at FROM trials WHERE id = ?')
      .get(trialId) as { departed_notified_at: string | null };
    expect(row.departed_notified_at).not.toBeNull();
  });

  it('mirrors to the audit channel without a ping', async () => {
    seedTrial();

    await notifyTrialDeparture(fakeGuild(vi.fn(async () => undefined)), {
      userId: 'u1',
      tag: 'brent#0001',
    });

    expect(auditNotice).toHaveBeenCalledWith(
      'Trial left the server',
      expect.stringContaining('user id `u1`'),
    );
  });

  it.each([['promoted'], ['closed']])('ignores a %s trial', async (status) => {
    seedTrial({ status });
    const send = vi.fn(async () => undefined);

    await expect(
      notifyTrialDeparture(fakeGuild(send), { userId: 'u1', tag: 'brent#0001' }),
    ).resolves.toBe('no_trial');
    expect(send).not.toHaveBeenCalled();
  });

  it('ignores a trial whose Discord user was never linked', async () => {
    seedTrial({ userId: null });
    const send = vi.fn(async () => undefined);

    await expect(
      notifyTrialDeparture(fakeGuild(send), { userId: 'u1', tag: 'brent#0001' }),
    ).resolves.toBe('no_trial');
    expect(send).not.toHaveBeenCalled();
  });

  it('ignores a trial already notified about', async () => {
    seedTrial({ notifiedAt: '2026-08-10 10:00:00' });

    await expect(
      notifyTrialDeparture(fakeGuild(vi.fn(async () => undefined)), {
        userId: 'u1',
        tag: 'brent#0001',
      }),
    ).resolves.toBe('no_trial');
  });

  it('does not stamp the row when the post fails, so the sweep can retry', async () => {
    const trialId = seedTrial();
    const send = vi.fn(async () => {
      throw new Error('missing permissions');
    });

    await expect(
      notifyTrialDeparture(fakeGuild(send), { userId: 'u1', tag: 'brent#0001' }),
    ).resolves.toBe('send_failed');
    const row = getDatabase()
      .prepare('SELECT departed_notified_at FROM trials WHERE id = ?')
      .get(trialId) as { departed_notified_at: string | null };
    expect(row.departed_notified_at).toBeNull();
  });

  it('does not stamp the row when the trial has no thread recorded', async () => {
    const trialId = seedTrial({ threadId: null });

    await expect(
      notifyTrialDeparture(fakeGuild(vi.fn(async () => undefined)), {
        userId: 'u1',
        tag: 'brent#0001',
      }),
    ).resolves.toBe('no_thread');
    const row = getDatabase()
      .prepare('SELECT departed_notified_at FROM trials WHERE id = ?')
      .get(trialId) as { departed_notified_at: string | null };
    expect(row.departed_notified_at).toBeNull();
  });

  it('stamps the row even when the audit mirror throws — the post is what matters', async () => {
    const trialId = seedTrial();
    vi.mocked(auditNotice).mockRejectedValueOnce(new Error('audit channel gone'));

    await expect(
      notifyTrialDeparture(fakeGuild(vi.fn(async () => undefined)), {
        userId: 'u1',
        tag: 'brent#0001',
      }),
    ).resolves.toBe('notified');
    const row = getDatabase()
      .prepare('SELECT departed_notified_at FROM trials WHERE id = ?')
      .get(trialId) as { departed_notified_at: string | null };
    expect(row.departed_notified_at).not.toBeNull();
  });
});

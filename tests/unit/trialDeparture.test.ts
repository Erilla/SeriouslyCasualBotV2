import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ChannelType, DiscordAPIError, RESTJSONErrorCodes } from 'discord.js';
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
import { sweepDepartures } from '../../src/functions/departures/sweepDepartures.js';

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
    const message = buildDepartureNotification(['o1'], {
      ...trialFacts,
      characterName: '@everyone',
    });

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

// ── sweepDepartures — the trials pass ────────────────────────────────────────

/** A guild where the named ids are gone and everyone else is still present. */
function fakeSweepGuild(departedIds: string[], send = vi.fn(async () => undefined)) {
  const thread = { id: 'THREAD', type: ChannelType.PublicThread, isTextBased: () => true, send };
  return {
    id: 'guild',
    channels: { cache: new Map([['THREAD', thread]]), fetch: async () => thread },
    client: { users: { fetch: async (id: string) => ({ tag: `tag-${id}` }) } },
    members: {
      fetch: async (id: string) => {
        if (departedIds.includes(id)) {
          throw new DiscordAPIError(
            { code: RESTJSONErrorCodes.UnknownMember, message: 'Unknown Member' } as never,
            RESTJSONErrorCodes.UnknownMember as never,
            404,
            'GET',
            '',
            {},
          );
        }
        return { id };
      },
    },
  } as never;
}

describe('sweepDepartures — the trials pass', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createTables(getDatabase(':memory:'));
  });
  afterEach(() => closeDatabase());

  it('notifies for an active trial whose user is gone, and stamps it', async () => {
    const trialId = seedTrial({ userId: 'gone' });

    const result = await sweepDepartures(fakeSweepGuild(['gone']));

    expect(result.trials).toEqual({ checked: 1, notified: 1, unresolved: 0 });
    const row = getDatabase()
      .prepare('SELECT departed_notified_at FROM trials WHERE id = ?')
      .get(trialId) as { departed_notified_at: string | null };
    expect(row.departed_notified_at).not.toBeNull();
  });

  it('leaves a trial alone when its user is still in the guild', async () => {
    seedTrial({ userId: 'present' });

    const result = await sweepDepartures(fakeSweepGuild([]));

    expect(result.trials).toEqual({ checked: 1, notified: 0, unresolved: 0 });
  });

  it('does not check a trial with no linked Discord user at all', async () => {
    seedTrial({ userId: null });

    const result = await sweepDepartures(fakeSweepGuild(['gone']));

    expect(result.trials.checked).toBe(0);
  });

  it('does not re-check a trial already notified about', async () => {
    seedTrial({ userId: 'gone', notifiedAt: '2026-08-10 10:00:00' });

    const result = await sweepDepartures(fakeSweepGuild(['gone']));

    expect(result.trials).toEqual({ checked: 0, notified: 0, unresolved: 0 });
  });

  it('reports the two subjects separately', async () => {
    const result = await sweepDepartures(fakeSweepGuild([]));

    expect(result).toEqual({
      applications: { checked: 0, notified: 0, unresolved: 0 },
      trials: { checked: 0, notified: 0, unresolved: 0 },
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Guild } from 'discord.js';
import { closeDatabase, getDatabase } from '../../src/database/db.js';
import { createTables } from '../../src/database/schema.js';

const { mockedAuditNotice } = vi.hoisted(() => ({
  mockedAuditNotice: vi.fn(async () => undefined),
}));

vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/config.js', () => ({
  config: { guildId: 'GUILD', officerRoleId: 'OFFICER' },
}));

vi.mock('../../src/services/auditLog.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/auditLog.js')>()),
  auditNotice: mockedAuditNotice,
}));

const { buildDepartureNotification, buildDepartureAuditDetail, DEPARTURE_AUDIT_TITLE } =
  await import('../../src/functions/applications/departureNotification.js');
const { notifyApplicantDeparture, findUnnotifiedDepartureApplication } =
  await import('../../src/functions/applications/notifyApplicantDeparture.js');

const FACTS = {
  characterName: 'Brentpriest',
  applicantTag: 'brent_hs',
  applicantUserId: 'U-APPLICANT',
  applicationId: 42,
};

// ── The copy (ticket #90, Draft A) ────────────────────────────────────────────

describe('buildDepartureNotification', () => {
  it('pings the overlords and names the character, the applicant and the way to close it', () => {
    const payload = buildDepartureNotification(['O1', 'O2'], FACTS);

    expect(payload.content).toBe(
      '<@O1> <@O2>\n' +
        '**Brentpriest** <@U-APPLICANT> (applicant) has left the server. ' +
        'Reject the application to close it off.',
    );
  });

  it('restricts mentions to the overlord ids, so an applicant-supplied name cannot ping', () => {
    const payload = buildDepartureNotification(['O1'], { ...FACTS, characterName: '@everyone' });

    expect(payload.allowedMentions).toEqual({ users: ['O1'] });
    expect(payload.content).toContain('**@everyone**');
  });

  it('falls back to the Discord tag when the application never captured a character name', () => {
    const payload = buildDepartureNotification(['O1'], { ...FACTS, characterName: null });

    expect(payload.content).toContain('**brent_hs** <@U-APPLICANT> (applicant)');
  });

  it('omits the mention line entirely when no overlords are configured', () => {
    const payload = buildDepartureNotification([], FACTS);

    expect(payload.content?.startsWith('**Brentpriest**')).toBe(true);
    expect(payload.allowedMentions).toEqual({ users: [] });
  });
});

describe('buildDepartureAuditDetail', () => {
  it('carries the raw user id, which the post deliberately does not', () => {
    expect(buildDepartureAuditDetail(FACTS)).toBe(
      'Brentpriest <@U-APPLICANT> (applicant) — application #42, user id `U-APPLICANT`',
    );
  });
});

// ── Selecting the application ─────────────────────────────────────────────────

interface SeedOptions {
  status?: string;
  threadId?: string | null;
  notifiedAt?: string | null;
  userId?: string;
  id?: number;
}

function seed(options: SeedOptions = {}): number {
  const id = options.id ?? 42;
  getDatabase()
    .prepare(
      `INSERT INTO applications
         (id, character_name, applicant_user_id, status, thread_id, departed_notified_at)
       VALUES (?, 'Brentpriest', ?, ?, ?, ?)`,
    )
    .run(
      id,
      options.userId ?? 'U-APPLICANT',
      options.status ?? 'active',
      options.threadId === undefined ? 'THREAD' : options.threadId,
      options.notifiedAt ?? null,
    );
  return id;
}

describe('findUnnotifiedDepartureApplication', () => {
  beforeEach(() => {
    createTables(getDatabase(':memory:'));
  });
  afterEach(() => closeDatabase());

  it('finds an application awaiting a decision', () => {
    seed();
    expect(findUnnotifiedDepartureApplication('U-APPLICANT')?.id).toBe(42);
  });

  it('ignores an applicant still working through the DM questionnaire', () => {
    seed({ status: 'in_progress' });
    expect(findUnnotifiedDepartureApplication('U-APPLICANT')).toBeUndefined();
  });

  it.each(['accepted', 'rejected', 'abandoned'])('ignores a %s application', (status) => {
    seed({ status });
    expect(findUnnotifiedDepartureApplication('U-APPLICANT')).toBeUndefined();
  });

  it('ignores an application already notified about', () => {
    seed({ notifiedAt: '2026-08-10 12:00:00' });
    expect(findUnnotifiedDepartureApplication('U-APPLICANT')).toBeUndefined();
  });

  it('returns nothing for a user with no application at all', () => {
    expect(findUnnotifiedDepartureApplication('U-STRANGER')).toBeUndefined();
  });
});

// ── Notifying ─────────────────────────────────────────────────────────────────

function guildWith(send: ReturnType<typeof vi.fn>, threadId = 'THREAD'): Guild {
  const thread = { id: threadId, type: 11, send };
  return {
    id: 'GUILD',
    channels: {
      cache: { get: (id: string) => (id === threadId ? thread : undefined) },
      fetch: vi.fn(async (id: string) => (id === threadId ? thread : null)),
    },
  } as unknown as Guild;
}

const notifiedAt = (id: number): string | null =>
  (
    getDatabase().prepare('SELECT departed_notified_at FROM applications WHERE id = ?').get(id) as {
      departed_notified_at: string | null;
    }
  ).departed_notified_at;

describe('notifyApplicantDeparture', () => {
  beforeEach(() => {
    createTables(getDatabase(':memory:'));
    getDatabase().prepare("INSERT INTO overlords (name, user_id) VALUES ('Bob', 'O1')").run();
    mockedAuditNotice.mockClear();
  });
  afterEach(() => closeDatabase());

  it('posts to the application thread and stamps the row exactly once', async () => {
    seed();
    const send = vi.fn(async () => undefined);

    const first = await notifyApplicantDeparture(guildWith(send), {
      userId: 'U-APPLICANT',
      tag: 'brent_hs',
    });
    expect(first).toBe('notified');
    expect(send).toHaveBeenCalledTimes(1);
    expect(notifiedAt(42)).not.toBeNull();

    const second = await notifyApplicantDeparture(guildWith(send), {
      userId: 'U-APPLICANT',
      tag: 'brent_hs',
    });
    expect(second).toBe('no_application');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('mirrors to the audit channel without a ping', async () => {
    seed();

    await notifyApplicantDeparture(guildWith(vi.fn(async () => undefined)), {
      userId: 'U-APPLICANT',
      tag: 'brent_hs',
    });

    expect(mockedAuditNotice).toHaveBeenCalledWith(
      DEPARTURE_AUDIT_TITLE,
      buildDepartureAuditDetail(FACTS),
    );
  });

  it('does not stamp the row when the post fails, so the sweep can retry', async () => {
    seed();
    const send = vi.fn(async () => {
      throw new Error('Thread is archived');
    });

    const outcome = await notifyApplicantDeparture(guildWith(send), {
      userId: 'U-APPLICANT',
      tag: 'brent_hs',
    });

    expect(outcome).toBe('send_failed');
    expect(notifiedAt(42)).toBeNull();
  });

  it('does not stamp the row when the application has no thread recorded', async () => {
    seed({ threadId: null });

    const outcome = await notifyApplicantDeparture(guildWith(vi.fn()), {
      userId: 'U-APPLICANT',
      tag: 'brent_hs',
    });

    expect(outcome).toBe('no_thread');
    expect(notifiedAt(42)).toBeNull();
  });

  it('stamps the row even when the audit mirror throws — the post is what matters', async () => {
    seed();
    mockedAuditNotice.mockRejectedValueOnce(new Error('audit channel gone'));

    const outcome = await notifyApplicantDeparture(guildWith(vi.fn(async () => undefined)), {
      userId: 'U-APPLICANT',
      tag: 'brent_hs',
    });

    expect(outcome).toBe('notified');
    expect(notifiedAt(42)).not.toBeNull();
  });
});

// ── The gateway handler ───────────────────────────────────────────────────────

describe('guildMemberRemove', () => {
  beforeEach(() => {
    createTables(getDatabase(':memory:'));
    getDatabase().prepare("INSERT INTO overlords (name, user_id) VALUES ('Bob', 'O1')").run();
  });
  afterEach(() => closeDatabase());

  const member = (guild: Guild, overrides: { bot?: boolean; guildId?: string } = {}) =>
    ({
      guild: overrides.guildId ? ({ ...guild, id: overrides.guildId } as Guild) : guild,
      id: 'U-APPLICANT',
      user: { id: 'U-APPLICANT', tag: 'brent_hs', bot: overrides.bot ?? false },
    }) as never;

  it('notifies when an applicant awaiting a decision leaves', async () => {
    seed();
    const send = vi.fn(async () => undefined);
    const event = (await import('../../src/events/guildMemberRemove.js')).default;

    await event.execute(member(guildWith(send)));

    expect(send).toHaveBeenCalledTimes(1);
    expect(notifiedAt(42)).not.toBeNull();
  });

  it('ignores departures from a guild that is not the configured one', async () => {
    seed();
    const send = vi.fn(async () => undefined);
    const event = (await import('../../src/events/guildMemberRemove.js')).default;

    await event.execute(member(guildWith(send), { guildId: 'OTHER-GUILD' }));

    expect(send).not.toHaveBeenCalled();
    expect(notifiedAt(42)).toBeNull();
  });

  it('ignores bots leaving', async () => {
    seed();
    const send = vi.fn(async () => undefined);
    const event = (await import('../../src/events/guildMemberRemove.js')).default;

    await event.execute(member(guildWith(send), { bot: true }));

    expect(send).not.toHaveBeenCalled();
  });

  it('never throws back into the gateway, even when channel lookup itself blows up', async () => {
    seed();
    // Not a failing send — notifyApplicantDeparture handles that internally. This
    // is the unguarded case: the Discord call throws synchronously, which without
    // the handler's own try/catch becomes an unhandled rejection and kills the bot.
    const exploding = {
      id: 'GUILD',
      channels: {
        cache: {
          get: () => {
            throw new Error('cache exploded');
          },
        },
        fetch: vi.fn(),
      },
    } as unknown as Guild;
    const event = (await import('../../src/events/guildMemberRemove.js')).default;

    await expect(event.execute(member(exploding))).resolves.toBeUndefined();
    expect(notifiedAt(42)).toBeNull();
  });
});

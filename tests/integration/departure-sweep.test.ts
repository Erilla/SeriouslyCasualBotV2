import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscordAPIError, RESTJSONErrorCodes, type Guild } from 'discord.js';
import { closeDatabase, getDatabase } from '../../src/database/db.js';
import { createTables } from '../../src/database/schema.js';

vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/config.js', () => ({
  config: { guildId: 'GUILD', officerRoleId: 'OFFICER' },
}));

vi.mock('../../src/services/auditLog.js', () => ({
  auditNotice: vi.fn(async () => undefined),
  alertOfficers: vi.fn(async () => undefined),
  audit: vi.fn(async () => undefined),
  setAuditChannel: vi.fn(),
}));

const { sweepDepartures } = await import('../../src/functions/departures/sweepDepartures.js');

/** The error Discord returns for a user who is not a member of the guild. */
function unknownMember(): DiscordAPIError {
  return new DiscordAPIError(
    { code: RESTJSONErrorCodes.UnknownMember, message: 'Unknown Member' },
    RESTJSONErrorCodes.UnknownMember,
    404,
    'GET',
    'https://discord.com/api/v10/guilds/GUILD/members/x',
    {},
  );
}

interface Applicant {
  id: number;
  userId: string;
  status?: string;
  notifiedAt?: string | null;
  threadId?: string | null;
}

function seed(applicants: Applicant[]): void {
  const insert = getDatabase().prepare(
    `INSERT INTO applications
       (id, character_name, applicant_user_id, status, thread_id, departed_notified_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const a of applicants) {
    insert.run(
      a.id,
      `Char${a.id}`,
      a.userId,
      a.status ?? 'active',
      a.threadId === undefined ? `THREAD-${a.id}` : a.threadId,
      a.notifiedAt ?? null,
    );
  }
}

interface GuildOptions {
  /** userId → what fetching that member does. */
  members: Record<string, 'present' | 'gone' | 'error'>;
  send?: ReturnType<typeof vi.fn>;
}

function guildWith(options: GuildOptions): { guild: Guild; send: ReturnType<typeof vi.fn> } {
  const send = options.send ?? vi.fn(async () => undefined);
  const guild = {
    id: 'GUILD',
    client: { users: { fetch: vi.fn(async (id: string) => ({ id, tag: `tag-${id}` })) } },
    members: {
      fetch: vi.fn(async (id: string) => {
        const state = options.members[id] ?? 'gone';
        if (state === 'gone') throw unknownMember();
        if (state === 'error') throw new Error('503 Service Unavailable');
        return { id };
      }),
    },
    channels: {
      cache: { get: (id: string) => ({ id, type: 11, send }) },
      fetch: vi.fn(async (id: string) => ({ id, type: 11, send })),
    },
  } as unknown as Guild;
  return { guild, send };
}

const notifiedAt = (id: number): string | null =>
  (
    getDatabase().prepare('SELECT departed_notified_at FROM applications WHERE id = ?').get(id) as {
      departed_notified_at: string | null;
    }
  ).departed_notified_at;

describe('sweepDepartures — the applications pass', () => {
  beforeEach(() => {
    createTables(getDatabase(':memory:'));
    getDatabase().prepare("INSERT INTO overlords (name, user_id) VALUES ('Bob', 'O1')").run();
  });
  afterEach(() => closeDatabase());

  it('notifies once and stamps a departure that happened while the bot was down', async () => {
    seed([{ id: 1, userId: 'U1' }]);
    const { guild, send } = guildWith({ members: { U1: 'gone' } });

    const result = (await sweepDepartures(guild)).applications;

    expect(result).toEqual({ checked: 1, notified: 1, unresolved: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(notifiedAt(1)).not.toBeNull();
  });

  it('does not notify twice across two boots', async () => {
    seed([{ id: 1, userId: 'U1' }]);
    const first = guildWith({ members: { U1: 'gone' } });
    await sweepDepartures(first.guild);

    const second = guildWith({ members: { U1: 'gone' } });
    const result = (await sweepDepartures(second.guild)).applications;

    expect(result).toEqual({ checked: 0, notified: 0, unresolved: 0 });
    expect(second.send).not.toHaveBeenCalled();
  });

  it('leaves an applicant who is still in the guild alone', async () => {
    seed([{ id: 1, userId: 'U1' }]);
    const { guild, send } = guildWith({ members: { U1: 'present' } });

    const result = (await sweepDepartures(guild)).applications;

    expect(result).toEqual({ checked: 1, notified: 0, unresolved: 0 });
    expect(send).not.toHaveBeenCalled();
    expect(notifiedAt(1)).toBeNull();
  });

  it('treats a transient Discord failure as unknown rather than as a departure', async () => {
    seed([{ id: 1, userId: 'U1' }]);
    const { guild, send } = guildWith({ members: { U1: 'error' } });

    const result = (await sweepDepartures(guild)).applications;

    expect(result).toEqual({ checked: 1, notified: 0, unresolved: 1 });
    expect(send).not.toHaveBeenCalled();
    // Unstamped, so the next boot tries again instead of losing the departure.
    expect(notifiedAt(1)).toBeNull();
  });

  it('skips applications that are not awaiting a decision', async () => {
    seed([
      { id: 1, userId: 'U1', status: 'in_progress' },
      { id: 2, userId: 'U2', status: 'accepted' },
      { id: 3, userId: 'U3', status: 'rejected' },
      { id: 4, userId: 'U4', status: 'abandoned' },
    ]);
    const { guild, send } = guildWith({ members: {} });

    const result = (await sweepDepartures(guild)).applications;

    expect(result).toEqual({ checked: 0, notified: 0, unresolved: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps going after one application fails to notify', async () => {
    seed([
      { id: 1, userId: 'U1', threadId: null },
      { id: 2, userId: 'U2' },
    ]);
    const { guild, send } = guildWith({ members: { U1: 'gone', U2: 'gone' } });

    const result = (await sweepDepartures(guild)).applications;

    expect(result).toEqual({ checked: 2, notified: 1, unresolved: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(notifiedAt(1)).toBeNull();
    expect(notifiedAt(2)).not.toBeNull();
  });

  it('never throws, even when the member lookup itself is unusable', async () => {
    seed([{ id: 1, userId: 'U1' }]);
    const broken = {
      id: 'GUILD',
      members: {
        get fetch(): never {
          throw new Error('members manager exploded');
        },
      },
    } as unknown as Guild;

    // Classified unresolved rather than swallowed: the row stays unstamped, so a
    // later boot with a working client still reports the departure.
    await expect(sweepDepartures(broken)).resolves.toEqual({
      applications: { checked: 1, notified: 0, unresolved: 1 },
      trials: { checked: 0, notified: 0, unresolved: 0 },
    });
    expect(notifiedAt(1)).toBeNull();
  });
});

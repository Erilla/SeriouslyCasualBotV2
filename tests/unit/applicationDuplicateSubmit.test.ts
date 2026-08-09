import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Guild } from 'discord.js';
import { closeDatabase, getDatabase } from '../../src/database/db.js';
import { createTables } from '../../src/database/schema.js';

const { mockedGetOrCreateChannel, mockedCreateForumPost, mockedStartIntelJob } = vi.hoisted(() => ({
  mockedGetOrCreateChannel: vi.fn(),
  mockedCreateForumPost: vi.fn(),
  mockedStartIntelJob: vi.fn(() => 1),
}));

vi.mock('../../src/config.js', () => ({ config: { guildId: 'guild-1', officerRoleId: null } }));
vi.mock('../../src/services/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/functions/channels.js', () => ({
  getOrCreateChannel: mockedGetOrCreateChannel,
}));
vi.mock('../../src/functions/applications/createForumPost.js', () => ({
  createForumPost: mockedCreateForumPost,
}));
vi.mock('../../src/functions/applications/intel/placeholders.js', () => ({
  startIntelJob: mockedStartIntelJob,
}));
vi.mock('../../src/functions/raids/linkCharacterIdentity.js', () => ({
  linkCharacterIdentity: vi.fn(),
}));
vi.mock('../../src/functions/raids/overlords.js', () => ({
  getOverlords: vi.fn(() => []),
  addOverlordsToThread: vi.fn(async () => undefined),
}));
vi.mock('../../src/functions/applications/applicationLogCategory.js', () => ({
  refreshPendingApplicationCategory: vi.fn(async () => undefined),
  resolveApplicationLogCategory: vi.fn(async () => null),
}));

import { submitApplication } from '../../src/functions/applications/submitApplication.js';

function makeGuild(createChannel: ReturnType<typeof vi.fn>): Guild {
  return {
    id: 'guild-1',
    channels: {
      create: createChannel,
      cache: { get: vi.fn(() => undefined) },
      fetch: vi.fn(async () => null),
    },
  } as unknown as Guild;
}

function makeClient(guild: Guild) {
  return { guilds: { cache: { get: vi.fn(() => guild) } } } as never;
}

const applicant = {
  id: 'applicant-1',
  tag: 'Applicant#0001',
  username: 'applicant',
  displayName: 'TestCharacter',
} as never;

function seedApplication(status: string, submittedAt: string | null = null): number {
  const db = getDatabase();
  const applicationId = Number(
    db
      .prepare(
        `INSERT INTO applications (applicant_user_id, status, character_name, submitted_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run('applicant-1', status, 'TestCharacter', submittedAt).lastInsertRowid,
  );
  const questionId = Number(
    db
      .prepare('INSERT INTO application_questions (question, sort_order) VALUES (?, ?)')
      .run('Question?', 1).lastInsertRowid,
  );
  db.prepare(
    'INSERT INTO application_answers (application_id, question_id, answer) VALUES (?, ?, ?)',
  ).run(applicationId, questionId, 'Answer.');
  return applicationId;
}

beforeEach(() => {
  closeDatabase();
  createTables(getDatabase(':memory:'));
  vi.clearAllMocks();
  mockedGetOrCreateChannel.mockResolvedValue({ id: 'applications-category' });
  mockedCreateForumPost.mockResolvedValue({ forumPost: { id: 'forum-1' }, threadId: 'thread-1' });
});

afterEach(() => {
  closeDatabase();
});

describe('submitApplication duplicate protection', () => {
  it('submits an in-progress application and reports it as submitted', async () => {
    const applicationId = seedApplication('in_progress');
    const createChannel = vi.fn(async () => ({
      id: 'channel-1',
      send: vi.fn(async () => undefined),
    }));

    const result = await submitApplication(
      makeClient(makeGuild(createChannel)),
      applicationId,
      applicant,
    );

    expect(result).toBe('submitted');
    expect(createChannel).toHaveBeenCalledTimes(1);
    expect(mockedCreateForumPost).toHaveBeenCalledTimes(1);
  });

  it('refuses to submit an application that is already active and creates no duplicate channel or thread', async () => {
    // The real incident: the summary DM's "Confirm & Submit" button stays live
    // forever, so a second click two days later re-ran the whole submission and
    // produced a second app-* channel and a second forum thread.
    const applicationId = seedApplication('active', '2026-08-06 21:58:33');
    const createChannel = vi.fn(async () => ({
      id: 'channel-2',
      send: vi.fn(async () => undefined),
    }));

    const result = await submitApplication(
      makeClient(makeGuild(createChannel)),
      applicationId,
      applicant,
    );

    expect(result).toBe('already_submitted');
    expect(createChannel).not.toHaveBeenCalled();
    expect(mockedCreateForumPost).not.toHaveBeenCalled();
    expect(mockedStartIntelJob).not.toHaveBeenCalled();
  });

  it('does not overwrite the stored channel and thread of an already-submitted application', async () => {
    // Re-submission previously overwrote channel_id/thread_id with the second
    // run's IDs, orphaning the original channel and thread that officers were
    // already discussing in.
    const applicationId = seedApplication('active', '2026-08-06 21:58:33');
    getDatabase()
      .prepare('UPDATE applications SET channel_id = ?, thread_id = ? WHERE id = ?')
      .run('original-channel', 'original-thread', applicationId);

    await submitApplication(
      makeClient(makeGuild(vi.fn(async () => ({ id: 'channel-2', send: vi.fn() })))),
      applicationId,
      applicant,
    );

    const row = getDatabase()
      .prepare('SELECT channel_id, thread_id FROM applications WHERE id = ?')
      .get(applicationId) as { channel_id: string; thread_id: string };
    expect(row.channel_id).toBe('original-channel');
    expect(row.thread_id).toBe('original-thread');
  });

  it('rejects a concurrent double-click so only one submission creates Discord artifacts', async () => {
    // Two clicks landing within the same Discord API round-trip would both read
    // status='in_progress' under a check-then-act guard. The claim must be atomic.
    const applicationId = seedApplication('in_progress');
    const createChannel = vi.fn(async () => ({
      id: 'channel-1',
      send: vi.fn(async () => undefined),
    }));
    const client = makeClient(makeGuild(createChannel));

    const results = await Promise.all([
      submitApplication(client, applicationId, applicant),
      submitApplication(client, applicationId, applicant),
    ]);

    expect(results.filter((r) => r === 'submitted')).toHaveLength(1);
    expect(results.filter((r) => r === 'already_submitted')).toHaveLength(1);
    expect(createChannel).toHaveBeenCalledTimes(1);
  });

  it('releases the claim when submission fails so the applicant can retry', async () => {
    const applicationId = seedApplication('in_progress');
    const failingGuild = makeGuild(
      vi.fn(async () => {
        throw new Error('Missing Permissions');
      }),
    );

    await expect(
      submitApplication(makeClient(failingGuild), applicationId, applicant),
    ).rejects.toThrow(/Failed to create application channel/);

    const row = getDatabase()
      .prepare('SELECT status, submitted_at FROM applications WHERE id = ?')
      .get(applicationId) as { status: string; submitted_at: string | null };
    expect(row.status).toBe('in_progress');
    expect(row.submitted_at).toBeNull();

    // And a retry after the failure succeeds rather than reporting a duplicate.
    const retry = await submitApplication(
      makeClient(makeGuild(vi.fn(async () => ({ id: 'channel-1', send: vi.fn() })))),
      applicationId,
      applicant,
    );
    expect(retry).toBe('submitted');
  });
});

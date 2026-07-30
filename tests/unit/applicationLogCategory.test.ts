import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType, type CategoryChannel, type Guild } from 'discord.js';
import { closeDatabase, getDatabase } from '../../src/database/db.js';
import { createTables } from '../../src/database/schema.js';

const {
  mockedGetOrCreateChannel,
  mockedResolveApplicationLogCategory,
  mockedRefreshPendingApplicationCategory,
  mockedCreateForumPost,
  mockedAudit,
  mockedAssignRaiderRole,
  mockedCreateTrialReviewThread,
  mockedDeployCommands,
} = vi.hoisted(() => ({
  mockedGetOrCreateChannel: vi.fn(),
  mockedResolveApplicationLogCategory: vi.fn(),
  mockedRefreshPendingApplicationCategory: vi.fn(),
  mockedCreateForumPost: vi.fn(),
  mockedAudit: vi.fn(async () => undefined),
  mockedAssignRaiderRole: vi.fn(async () => undefined),
  mockedCreateTrialReviewThread: vi.fn(async () => undefined),
  mockedDeployCommands: vi.fn(async () => undefined),
}));

vi.mock('../../src/services/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    setDiscordChannel: vi.fn(),
  },
}));

vi.mock('../../src/functions/channels.js', () => ({
  getOrCreateChannel: mockedGetOrCreateChannel,
}));

vi.mock('../../src/functions/applications/applicationLogCategory.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../src/functions/applications/applicationLogCategory.js')
    >();
  return {
    ...actual,
    resolveApplicationLogCategory: mockedResolveApplicationLogCategory.mockImplementation(
      actual.resolveApplicationLogCategory,
    ),
    refreshPendingApplicationCategory: mockedRefreshPendingApplicationCategory.mockImplementation(
      actual.refreshPendingApplicationCategory,
    ),
  };
});

vi.mock('../../src/functions/raids/overlords.js', () => ({
  addOverlordsToThread: vi.fn(async () => undefined),
  getOverlords: vi.fn(() => []),
}));

vi.mock('../../src/functions/applications/createForumPost.js', () => ({
  createForumPost: mockedCreateForumPost,
}));
vi.mock('../../src/services/auditLog.js', () => ({ audit: mockedAudit }));
vi.mock('../../src/functions/applications/assignRaiderRole.js', () => ({
  assignRaiderRole: mockedAssignRaiderRole,
}));
vi.mock('../../src/functions/trial-review/createTrialReviewThread.js', () => ({
  createTrialReviewThread: mockedCreateTrialReviewThread,
}));
vi.mock('../../src/deploy-commands.js', () => ({ deployCommands: mockedDeployCommands }));
vi.mock('../../src/scheduler/scheduler.js', () => ({
  Scheduler: class {
    registerCron(): void {}
    start() {
      return { intervals: 0, crons: 0 };
    }
  },
}));
vi.mock('../../src/functions/raids/alertSignups.js', () => ({ alertSignups: vi.fn() }));
vi.mock('../../src/functions/raids/alertHighestMythicPlusDone.js', () => ({
  alertHighestMythicPlusDone: vi.fn(),
}));
vi.mock('../../src/functions/guild-info/updateAchievements.js', () => ({
  updateAchievements: vi.fn(),
}));
vi.mock('../../src/functions/trial-review/scheduleTrialAlerts.js', () => ({
  rescheduleAllAlerts: vi.fn(() => ({
    pastDue: 0,
    scheduled: 0,
    promotePastDue: 0,
    promoteScheduled: 0,
  })),
}));
vi.mock('../../src/functions/applications/resumeSessions.js', () => ({
  resumeSessions: vi.fn(async () => 0),
}));
vi.mock('../../src/functions/backups/dailyBackup.js', () => ({ dailyBackup: vi.fn() }));
vi.mock('../../src/functions/maintenance/runDailyMaintenance.js', () => ({
  runDailyMaintenance: vi.fn(),
}));
vi.mock('../../src/services/statusTracker.js', () => ({ recordTaskRun: vi.fn() }));
vi.mock('../../src/services/buildInfo.js', () => ({ getBuildInfo: vi.fn(async () => ({})) }));

import {
  refreshPendingApplicationCategory,
  resolveApplicationLogCategory,
} from '../../src/functions/applications/applicationLogCategory.js';
import { submitApplication } from '../../src/functions/applications/submitApplication.js';
import { processAcceptModal } from '../../src/functions/applications/acceptApplication.js';
import { processRejectModal } from '../../src/functions/applications/rejectApplication.js';
import readyEvent from '../../src/events/ready.js';
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

function seedApplication(status: string): number {
  return Number(
    getDatabase()
      .prepare('INSERT INTO applications (applicant_user_id, status) VALUES (?, ?)')
      .run(crypto.randomUUID(), status).lastInsertRowid,
  );
}

function seedApplicationWithAnswers(status: string): number {
  const applicationId = Number(
    getDatabase()
      .prepare(
        'INSERT INTO applications (applicant_user_id, status, character_name) VALUES (?, ?, ?)',
      )
      .run('applicant-1', status, 'TestCharacter').lastInsertRowid,
  );
  const questionId = Number(
    getDatabase()
      .prepare('INSERT INTO application_questions (question, sort_order) VALUES (?, ?)')
      .run('Question?', 1).lastInsertRowid,
  );
  getDatabase()
    .prepare(
      'INSERT INTO application_answers (application_id, question_id, answer) VALUES (?, ?, ?)',
    )
    .run(applicationId, questionId, 'Answer.');
  return applicationId;
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

  it('uses the resolved category as the application-log forum parent', async () => {
    const category = makeCategory({ id: 'category-1', name: 'Application-logs' });
    const forum = {
      id: 'forum-1',
      availableTags: [{ id: 'active-tag', name: 'Active' }],
      threads: {
        create: vi.fn(async () => ({
          id: 'thread-1',
          send: vi.fn(async () => undefined),
        })),
      },
    };
    mockedResolveApplicationLogCategory.mockResolvedValueOnce(category);
    mockedGetOrCreateChannel.mockResolvedValueOnce(forum);

    const { createForumPost: actualCreateForumPost } = await vi.importActual<
      typeof import('../../src/functions/applications/createForumPost.js')
    >('../../src/functions/applications/createForumPost.js');
    await actualCreateForumPost(
      makeGuild([]),
      'TestCharacter',
      { id: 'applicant-1' } as never,
      'answers',
      1,
    );

    expect(mockedGetOrCreateChannel).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ categoryName: null, createOptions: { parent: 'category-1' } }),
    );
  });

  it('refreshes after active, accepted, and rejected application updates', async () => {
    const submittedId = seedApplicationWithAnswers('in_progress');
    const acceptedId = seedApplication('active');
    const rejectedId = seedApplication('active');
    const guild = {
      id: 'guild-1',
      channels: {
        create: vi.fn(async () => ({ id: 'channel-1', send: vi.fn(async () => undefined) })),
        cache: { get: vi.fn(() => undefined) },
        fetch: vi.fn(async () => null),
      },
    } as unknown as Guild;
    mockedGetOrCreateChannel.mockResolvedValue({ id: 'applications-category' });
    mockedCreateForumPost.mockResolvedValue({ forumPost: { id: 'forum-1' }, threadId: '' });

    await submitApplication(
      { guilds: { cache: { get: vi.fn(() => guild) } } } as never,
      submittedId,
      { id: 'applicant-1', tag: 'Applicant#0001', displayName: 'TestCharacter' } as never,
    );

    const makeModalInteraction = (applicationId: number, fields: Record<string, string>) =>
      ({
        customId: `application:modal:decision:${applicationId}`,
        fields: { getTextInputValue: (id: string) => fields[id] },
        deferReply: vi.fn(async () => undefined),
        editReply: vi.fn(async () => undefined),
        guild,
        user: { id: 'officer-1', toString: () => '@Officer' },
        client: { users: { fetch: vi.fn(async () => ({ send: vi.fn(async () => undefined) })) } },
      }) as never;

    await processAcceptModal(
      makeModalInteraction(acceptedId, {
        character_name: 'TestCharacter',
        role: 'DPS',
        start_date: '2026-07-30',
        message_to_applicant: 'Welcome!',
      }),
    );
    await processRejectModal(makeModalInteraction(rejectedId, { message_to_applicant: 'Sorry.' }));

    expect(mockedRefreshPendingApplicationCategory).toHaveBeenCalledTimes(3);
  });

  it('refreshes the pending application category during ready bootstrap', async () => {
    const guild = { id: 'guild-1' } as Guild;

    await readyEvent.execute({
      user: { tag: 'TestBot#0001' },
      guilds: { fetch: vi.fn(async () => guild) },
    } as never);

    expect(mockedRefreshPendingApplicationCategory).toHaveBeenCalledWith(guild);
  });
});

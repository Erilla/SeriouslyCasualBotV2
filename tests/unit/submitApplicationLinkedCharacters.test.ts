import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Guild } from 'discord.js';
import { closeDatabase, getDatabase } from '../../src/database/db.js';
import { createTables } from '../../src/database/schema.js';
import type { CharacterLinkCandidate } from '../../src/functions/applications/characterLinks.js';
import type { CharacterLinkResolution } from '../../src/functions/applications/resolveCharacterLinks.js';

const { mockedGetOrCreateChannel, mockedCreateForumPost, mockedResolveCharacterLinks } = vi.hoisted(
  () => ({
    mockedGetOrCreateChannel: vi.fn(),
    mockedCreateForumPost: vi.fn(),
    mockedResolveCharacterLinks: vi.fn(),
  }),
);

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

// The only boundary stubbed. Resolution is three live APIs (Blizzard's realm
// index, WarcraftLogs and Raider.IO); everything between the applicant's answer
// text and the job the scheduler will read is the real code, including the real
// parser and the real job store.
vi.mock('../../src/functions/applications/resolveCharacterLinks.js', () => ({
  resolveCharacterLinks: mockedResolveCharacterLinks,
  MAX_LINK_CANDIDATES: 30,
}));

const { submitApplication } = await import('../../src/functions/applications/submitApplication.js');
const { getApplicantCharacters, getJobByApplication, getLinkedCharacters } =
  await import('../../src/functions/applications/intel/jobStore.js');

function makeGuild(): Guild {
  return {
    id: 'guild-1',
    channels: {
      create: vi.fn(async () => ({ id: 'channel-1', send: vi.fn(async () => undefined) })),
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
  displayName: 'Kiuasdk',
} as never;

/** Seed an application whose answers are the given texts, in order. */
function seedApplication(answers: string[]): number {
  const db = getDatabase();
  const applicationId = Number(
    db
      .prepare(
        `INSERT INTO applications (applicant_user_id, status, character_name)
         VALUES (?, 'in_progress', ?)`,
      )
      .run('applicant-1', 'Kiuasdk').lastInsertRowid,
  );
  answers.forEach((answer, index) => {
    const questionId = Number(
      db
        .prepare('INSERT INTO application_questions (question, sort_order) VALUES (?, ?)')
        .run(`Question ${index + 1}?`, index + 1).lastInsertRowid,
    );
    db.prepare(
      'INSERT INTO application_answers (application_id, question_id, answer) VALUES (?, ?, ?)',
    ).run(applicationId, questionId, answer);
  });
  return applicationId;
}

beforeEach(() => {
  closeDatabase();
  createTables(getDatabase(':memory:'));
  vi.clearAllMocks();
  mockedGetOrCreateChannel.mockResolvedValue({ id: 'applications-category' });
  mockedCreateForumPost.mockResolvedValue({ forumPost: { id: 'forum-1' }, threadId: 'thread-1' });
  // Stand in for the live lookups: every parsed candidate canonicalises to
  // itself and Raider.IO confirms it. Derived from the candidates actually
  // passed in, so the test still proves the parser output reached resolution.
  mockedResolveCharacterLinks.mockImplementation(
    async (candidates: CharacterLinkCandidate[]): Promise<CharacterLinkResolution> => {
      const identities = candidates.flatMap((candidate) =>
        candidate.source === 'warcraftlogs-id' ? [] : [candidate.character],
      );
      return {
        identities,
        statuses: identities.map((identity, index) => ({
          candidate: candidates[index],
          identity,
          status: 'verified' as const,
        })),
      };
    },
  );
});

afterEach(() => {
  closeDatabase();
});

describe('submitApplication seeds characters linked by any supported source', () => {
  // The live miss this covers: an applicant linked their druid twice, both times
  // as a WarcraftLogs URL, and the intel sweep never looked at it. The answers
  // are only ever parsed here — the message-harvest path cannot see them,
  // because the questionnaire runs in DMs and the Q&A repost is bot-authored.
  const answers = [
    'https://raider.io/characters/eu/tarren-mill/Kiuasdk',
    'CE in latest season as resto: https://www.warcraftlogs.com/character/eu/tarren-mill/braene\n' +
      'and https://www.warcraftlogs.com/character/eu/tarren-mill/kiuaspal?zone=44',
  ];

  it('queues a character linked only by a WarcraftLogs URL', async () => {
    const applicationId = seedApplication(answers);

    await submitApplication(makeClient(makeGuild()), applicationId, applicant);

    const job = getJobByApplication(applicationId);
    expect(job).toBeDefined();
    expect(getLinkedCharacters(job!.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Braene', realm: 'tarren-mill', region: 'eu' }),
        expect.objectContaining({ name: 'Kiuaspal', realm: 'tarren-mill', region: 'eu' }),
      ]),
    );
  });

  it('keeps the Raider.IO character as the applicant character and primary', async () => {
    const applicationId = seedApplication(answers);

    await submitApplication(makeClient(makeGuild()), applicationId, applicant);

    const job = getJobByApplication(applicationId)!;
    expect(job.character_name).toBe('Kiuasdk');
    expect(getApplicantCharacters(job.id)).toEqual([
      { region: 'eu', realm: 'tarren-mill', name: 'Kiuasdk' },
    ]);
    // Already an applicant character; queueing it again would double-count it.
    expect(getLinkedCharacters(job.id).map((c) => c.name)).not.toContain('Kiuasdk');
  });

  it('submits normally when the answers link nobody', async () => {
    const applicationId = seedApplication(['No links here, sorry.']);

    const result = await submitApplication(makeClient(makeGuild()), applicationId, applicant);

    expect(result).toBe('submitted');
    expect(mockedResolveCharacterLinks).not.toHaveBeenCalled();
    expect(getLinkedCharacters(getJobByApplication(applicationId)!.id)).toEqual([]);
  });
});

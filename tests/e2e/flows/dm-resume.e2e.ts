/**
 * Flow: resumeSessions() correctly restores in-progress DM applications after
 * a simulated bot restart.
 *
 * Strategy
 * --------
 * - `resetAndSeed({ discord: false })` for speed — no Discord channels needed.
 * - Seed an `in_progress` application directly in the DB for the tester user,
 *   with `current_question_id` pointing to the first question.
 * - Mock `client.users.fetch()` to return a fake User whose `send()` is
 *   captured so we can assert the resume DM without hitting real Discord.
 * - Invoke `resumeSessions(client)` directly.
 *
 * Assertions
 * ----------
 * 1. When there are no in-progress applications, resumeSessions() is a no-op
 *    (activeSessions is not modified).
 * 2. An in-progress application with one answer already given (questionIndex=1)
 *    is restored into activeSessions with the correct applicationId and
 *    questionIndex.
 * 3. A resume DM is sent to the applicant containing the question number and
 *    the question text.
 * 4. A session at the summary stage (count >= questions.length) is skipped —
 *    no activeSessions entry, no DM.
 * 5. When client.users.fetch() throws (user not found), the session is removed
 *    from activeSessions and no DM is attempted.
 *
 * Deferred
 * --------
 * - Testing that the restored session correctly handles subsequent DM replies
 *   (i.e., handleDmMessage picks up from the restored questionIndex) is
 *   already covered by the apply-modal flow tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Client, User } from 'discord.js';
import { getE2EContext } from '../setup/bootstrap.js';
import { resetAndSeed } from '../setup/baseline.js';
import { getDatabase } from '../../../src/database/db.js';
import { resumeSessions } from '../../../src/functions/applications/resumeSessions.js';
import {
  activeSessions,
} from '../../../src/functions/applications/dmQuestionnaire.js';
import { getQuestions } from '../../../src/functions/applications/applicationQuestions.js';
import type { ApplicationQuestionRow } from '../../../src/types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SeedAppOptions {
  userId: string;
  /** Number of answers already recorded (determines questionIndex). */
  answersCount: number;
}

/**
 * Insert an in_progress application row and the requested number of answer
 * rows for it.  Returns the inserted application id.
 */
function seedInProgressApp(opts: SeedAppOptions): number {
  const db = getDatabase();
  const questions = db
    .prepare('SELECT * FROM application_questions ORDER BY sort_order')
    .all() as ApplicationQuestionRow[];

  if (questions.length === 0) {
    throw new Error('seedInProgressApp: no application_questions in DB');
  }

  // Pick current_question_id as the next unanswered question (or null if at summary).
  const nextQuestion = questions[opts.answersCount] ?? null;

  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO applications (applicant_user_id, status, current_question_id)
       VALUES (?, 'in_progress', ?)`,
    )
    .run(opts.userId, nextQuestion?.id ?? null);

  const applicationId = lastInsertRowid as number;

  // Insert dummy answer rows so COUNT(*) returns answersCount.
  for (let i = 0; i < opts.answersCount; i++) {
    db.prepare(
      'INSERT INTO application_answers (application_id, question_id, answer) VALUES (?, ?, ?)',
    ).run(applicationId, questions[i]!.id, `Seeded answer ${i + 1}`);
  }

  return applicationId;
}

/**
 * Build a fake Client whose `users.fetch()` resolves to `fakeUser`.
 * Pass `shouldThrow: true` to simulate a fetch failure (user not in guild).
 */
function buildFakeClient(fakeUser: User, shouldThrow = false): Client {
  return {
    users: {
      fetch: async (_id: string) => {
        if (shouldThrow) throw new Error('Unknown User');
        return fakeUser;
      },
    },
  } as unknown as Client;
}

/**
 * Build a fake User with a captured `send()` and the given id.
 */
function buildFakeUser(id: string): { user: User; sentMessages: string[] } {
  const sentMessages: string[] = [];
  const user = {
    id,
    tag: `FakeUser#${id.slice(-4)}`,
    send: async (content: unknown) => {
      if (typeof content === 'string') sentMessages.push(content);
      else if (content && typeof content === 'object' && 'content' in content) {
        sentMessages.push((content as { content: string }).content);
      } else {
        sentMessages.push(String(content));
      }
      return {};
    },
  } as unknown as User;
  return { user, sentMessages };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resumeSessions — DM resume flow', () => {
  let testUserId: string;

  beforeEach(async () => {
    await resetAndSeed({ discord: false });

    const ctx = getE2EContext();
    testUserId = ctx.tester.user.id;

    // Clean up any leftover session from a previous test in this process.
    activeSessions.delete(testUserId);
  });

  afterEach(() => {
    // Clean up sessions (and their timeouts) created by resumeSessions().
    const session = activeSessions.get(testUserId);
    if (session?.timeout) clearTimeout(session.timeout);
    activeSessions.delete(testUserId);
  });

  // =========================================================================
  // 1. No-op when no in-progress applications exist
  // =========================================================================

  it('is a no-op when there are no in_progress applications', async () => {
    // The DB after resetAndSeed has no in_progress rows (they get wiped and
    // seeded with a 'submitted' one).  Delete any stragglers to be safe.
    const db = getDatabase();
    db.prepare(`DELETE FROM applications WHERE status = 'in_progress'`).run();

    const { user } = buildFakeUser(testUserId);
    const fakeClient = buildFakeClient(user);

    const sizeBefore = activeSessions.size;
    await resumeSessions(fakeClient);

    // Sessions map must not have grown.
    expect(activeSessions.size).toBe(sizeBefore);
    expect(activeSessions.has(testUserId)).toBe(false);
  });

  // =========================================================================
  // 2. Session is restored with correct applicationId and questionIndex
  // =========================================================================

  it('restores an in-progress application into activeSessions at the correct questionIndex', async () => {
    const questions = getQuestions();
    expect(questions.length, 'need at least 2 questions in DB').toBeGreaterThanOrEqual(2);

    // Seed app with 1 answer already given → questionIndex should be 1.
    const applicationId = seedInProgressApp({ userId: testUserId, answersCount: 1 });

    const { user } = buildFakeUser(testUserId);
    const fakeClient = buildFakeClient(user);

    await resumeSessions(fakeClient);

    const session = activeSessions.get(testUserId);
    expect(session, 'session must be present in activeSessions').toBeDefined();
    expect(session!.applicationId).toBe(applicationId);
    expect(session!.questionIndex).toBe(1);
  });

  // =========================================================================
  // 3. Resume DM is sent with question number and text
  // =========================================================================

  it('sends a resume DM containing the question number and question text', async () => {
    const questions = getQuestions();
    expect(questions.length, 'need at least 2 questions').toBeGreaterThanOrEqual(2);

    // 1 answer recorded → next question is questions[1]
    seedInProgressApp({ userId: testUserId, answersCount: 1 });

    const { user, sentMessages } = buildFakeUser(testUserId);
    const fakeClient = buildFakeClient(user);

    await resumeSessions(fakeClient);

    expect(sentMessages.length).toBeGreaterThanOrEqual(1);

    const resumeDm = sentMessages[0]!;
    // Should mention "Question 2/<total>" and the question text.
    expect(resumeDm).toContain(`Question 2/${questions.length}`);
    expect(resumeDm).toContain(questions[1]!.question);
    // Should also mention it's resuming after restart.
    expect(resumeDm).toMatch(/restart|continue|left off/i);
  });

  // =========================================================================
  // 4. Summary-stage application is skipped (all questions answered)
  // =========================================================================

  it('skips an application where all questions are already answered (summary stage)', async () => {
    const questions = getQuestions();
    expect(questions.length, 'need at least 1 question').toBeGreaterThan(0);

    // Seed app with ALL answers given → at summary stage.
    seedInProgressApp({ userId: testUserId, answersCount: questions.length });

    const { user, sentMessages } = buildFakeUser(testUserId);
    const fakeClient = buildFakeClient(user);

    await resumeSessions(fakeClient);

    // No session should have been created for this user.
    expect(activeSessions.has(testUserId)).toBe(false);
    // No DM should have been sent.
    expect(sentMessages).toHaveLength(0);
  });

  // =========================================================================
  // 5. If client.users.fetch() throws, session is removed and no DM sent
  // =========================================================================

  it('removes the session and skips the DM if the user cannot be fetched', async () => {
    const questions = getQuestions();
    expect(questions.length, 'need at least 1 question').toBeGreaterThan(0);

    // Seed app at first question (0 answers).
    seedInProgressApp({ userId: testUserId, answersCount: 0 });

    const { user, sentMessages } = buildFakeUser(testUserId);
    // Client that always throws on fetch → simulates user left or DMs closed
    const fakeClient = buildFakeClient(user, /* shouldThrow */ true);

    await resumeSessions(fakeClient);

    // resumeSessions() catches the error and deletes the session it just added.
    expect(activeSessions.has(testUserId)).toBe(false);
    // No DM attempted.
    expect(sentMessages).toHaveLength(0);
  });
});

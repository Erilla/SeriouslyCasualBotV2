/**
 * Flow: full DM Q&A cycle for /apply.
 *
 * Strategy
 * --------
 * - `handleDmMessage` is exported directly from `dmQuestionnaire.ts`, so we
 *   invoke it without going through the `messageCreate` event handler.
 * - `activeSessions` is also exported so we can inspect session state.
 * - We mock `user.send()` to capture outbound DM content and prevent real
 *   Discord API calls (the test uses `discord: false`, DB only).
 * - The final step (`submitApplication`) creates real Discord channels/forum
 *   posts, so we stop at the summary stage and assert DB state instead.
 *   Deferred item: full submit path via `application:confirm:` button is not
 *   covered here (it requires `discord: true` and an active text/forum setup).
 *
 * Assertions
 * ----------
 * 1. `/apply` handler creates an `in_progress` row and the session is active.
 * 2. The first DM the bot sends contains "Question 1".
 * 3. After answering each question via `handleDmMessage`, an answer row is
 *    recorded in `application_answers`.
 * 4. After the final answer, the session is cleared and the bot sends the
 *    summary (user.send calls include "Application Summary").
 * 5. All `application_answers` rows exist with the correct content.
 * 6. `character_name` on the application row is set from the first answer.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { ChatInputCommandInteraction, TextBasedChannel, Message, User } from 'discord.js';
import { getE2EContext } from '../setup/bootstrap.js';
import { fakeChatInput } from '../setup/synthesizer.js';
import { resetAndSeed } from '../setup/baseline.js';
import { queryOne, queryAll } from '../setup/assertions.js';
import { getDatabase } from '../../../src/database/db.js';
import applyCmd from '../../../src/commands/apply.js';
import { handleDmMessage, activeSessions } from '../../../src/functions/applications/dmQuestionnaire.js';
import { getQuestions } from '../../../src/functions/applications/applicationQuestions.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ApplicationRow {
  id: number;
  status: string;
  character_name: string | null;
}

interface AnswerRow {
  id: number;
  application_id: number;
  question_id: number;
  answer: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal fake Message that satisfies `handleDmMessage`'s needs.
 *
 * handleDmMessage reads:
 *   - message.author.id  (to look up the session)
 *   - message.author     (passed to startSessionTimeout, user.send)
 *   - message.content    (the applicant's answer text)
 *   - message.author.bot (checked by the messageCreate event wrapper — we
 *     bypass that layer and call handleDmMessage directly, so it is not
 *     checked here, but we set it to false for correctness)
 *
 * The real `user` from E2EContext is used for `author` so that `user.send`
 * is our captured mock.
 */
function buildFakeMessage(user: User, content: string): Message {
  return {
    author: user,
    content,
    guild: null, // signals a DM (no guild)
  } as unknown as Message;
}

/**
 * Create a user proxy that captures all `user.send()` calls in `sentMessages`
 * and silently succeeds (no real Discord API call).
 */
function createMockedUser(realUser: User): { user: User; sentMessages: string[] } {
  const sentMessages: string[] = [];

  const user = Object.create(realUser) as User;
  user.send = async (content: unknown) => {
    if (typeof content === 'string') {
      sentMessages.push(content);
    } else if (content && typeof content === 'object' && 'content' in content) {
      sentMessages.push((content as { content: string }).content);
    } else {
      sentMessages.push(String(content));
    }
    // Return a minimal message-like object to satisfy callers.
    return {} as Message;
  };

  return { user, sentMessages };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('apply — DM Q&A flow', () => {
  beforeEach(async () => {
    // DB-only reset: no Discord channel creation, fast.
    await resetAndSeed({ discord: false });

    // Clean up any leftover in-memory session for the tester from a previous
    // test run in the same process.
    const ctx = getE2EContext();
    activeSessions.delete(ctx.tester.user.id);
  });

  // =========================================================================
  // Smoke: /apply creates the session and sends the first question
  // =========================================================================

  it('/apply creates an in_progress application and sends the first DM question', async () => {
    const ctx = getE2EContext();
    const { user, sentMessages } = createMockedUser(ctx.tester.user);
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.tester,
      user,
      commandName: 'apply',
    });

    await applyCmd.execute(iact as unknown as ChatInputCommandInteraction);

    // 1. Ephemeral ack was sent.
    expect(iact.__replies).toHaveLength(1);
    expect(iact.__replies[0]!.ephemeral).toBe(true);

    // 2. An in_progress application row was created.
    const app = queryOne<ApplicationRow>(
      "SELECT id, status, character_name FROM applications WHERE applicant_user_id = ? AND status = 'in_progress'",
      [user.id],
    );
    expect(app).toBeDefined();
    expect(app!.status).toBe('in_progress');

    // 3. A DM was sent with the first question.
    expect(sentMessages.length).toBeGreaterThanOrEqual(1);
    const firstDm = sentMessages[0]!;
    expect(firstDm).toContain('Question 1');

    // 4. The session is active.
    const session = activeSessions.get(user.id);
    expect(session).toBeDefined();
    expect(session!.applicationId).toBe(app!.id);
    expect(session!.questionIndex).toBe(0);

    // Clean up timeout so vitest can exit cleanly.
    if (session?.timeout) clearTimeout(session.timeout);
    activeSessions.delete(user.id);
  });

  // =========================================================================
  // Full cycle: answer every question → see summary
  // =========================================================================

  it('answering all questions records answers in DB and sends summary', async () => {
    const ctx = getE2EContext();
    const { user, sentMessages } = createMockedUser(ctx.tester.user);
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.tester,
      user,
      commandName: 'apply',
    });

    // Start the application.
    await applyCmd.execute(iact as unknown as ChatInputCommandInteraction);

    // Confirm we have a session and an application.
    const app = queryOne<ApplicationRow>(
      "SELECT id, status, character_name FROM applications WHERE applicant_user_id = ? AND status = 'in_progress'",
      [user.id],
    );
    expect(app).toBeDefined();
    const applicationId = app!.id;

    const questions = getQuestions();
    expect(questions.length).toBeGreaterThan(0);

    // Provide one answer per question via handleDmMessage.
    const answers: string[] = questions.map((q, i) => `Test Answer ${i + 1} for: ${q.question.substring(0, 20)}`);

    for (const answer of answers) {
      const msg = buildFakeMessage(user, answer);
      await handleDmMessage(msg);
    }

    // After all answers the session should be cleared.
    expect(activeSessions.has(user.id)).toBe(false);

    // All answer rows should be in the DB.
    const dbAnswers = queryAll<AnswerRow>(
      'SELECT * FROM application_answers WHERE application_id = ?',
      [applicationId],
    );
    expect(dbAnswers).toHaveLength(questions.length);

    // Each answer content matches what we submitted.
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i]!;
      const dbRow = dbAnswers.find((r) => r.question_id === q.id);
      expect(dbRow, `answer for question #${q.id} must exist`).toBeDefined();
      expect(dbRow!.answer).toBe(answers[i]);
    }

    // character_name is set from the first answer.
    const freshApp = queryOne<ApplicationRow>(
      'SELECT id, status, character_name FROM applications WHERE id = ?',
      [applicationId],
    );
    expect(freshApp!.character_name).toBe(answers[0]!.substring(0, 100));

    // The bot sent a summary DM (contains "Application Summary").
    const hasSummary = sentMessages.some((m) => m.includes('Application Summary'));
    expect(hasSummary).toBe(true);
  });

  // =========================================================================
  // Partial cycle: first answer is recorded immediately
  // =========================================================================

  it('first DM answer is recorded without completing the full questionnaire', async () => {
    const ctx = getE2EContext();
    const { user, sentMessages } = createMockedUser(ctx.tester.user);
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.tester,
      user,
      commandName: 'apply',
    });

    await applyCmd.execute(iact as unknown as ChatInputCommandInteraction);

    const app = queryOne<ApplicationRow>(
      "SELECT id, status, character_name FROM applications WHERE applicant_user_id = ? AND status = 'in_progress'",
      [user.id],
    );
    expect(app).toBeDefined();
    const applicationId = app!.id;

    const questions = getQuestions();
    expect(questions.length).toBeGreaterThan(1);

    // Only answer the first question.
    const firstAnswer = 'MyCharacterName';
    await handleDmMessage(buildFakeMessage(user, firstAnswer));

    // One answer row should exist.
    const dbAnswers = queryAll<AnswerRow>(
      'SELECT * FROM application_answers WHERE application_id = ?',
      [applicationId],
    );
    expect(dbAnswers).toHaveLength(1);
    expect(dbAnswers[0]!.answer).toBe(firstAnswer);

    // character_name is set from the first answer.
    const freshApp = queryOne<ApplicationRow>(
      'SELECT id, status, character_name FROM applications WHERE id = ?',
      [applicationId],
    );
    expect(freshApp!.character_name).toBe(firstAnswer);

    // Bot sent the second question DM.
    // sentMessages[0] = question 1 (from /apply), sentMessages[1] = question 2 (after first answer)
    expect(sentMessages.length).toBeGreaterThanOrEqual(2);
    expect(sentMessages[1]).toContain('Question 2');

    // Session is still active (more questions remain).
    const session = activeSessions.get(user.id);
    expect(session).toBeDefined();
    expect(session!.questionIndex).toBe(1);

    // Clean up.
    if (session?.timeout) clearTimeout(session.timeout);
    activeSessions.delete(user.id);
  });

  // =========================================================================
  // No-session guard: DM from user with no active session is ignored
  // =========================================================================

  it('DM from user with no active session is silently ignored', async () => {
    const ctx = getE2EContext();
    const { user } = createMockedUser(ctx.tester.user);

    // Confirm there is no session for this user.
    activeSessions.delete(user.id);
    expect(activeSessions.has(user.id)).toBe(false);

    // Should not throw, should not create any DB rows.
    const db = getDatabase();
    const beforeCount = (db.prepare('SELECT COUNT(*) as n FROM application_answers').get() as { n: number }).n;

    const msg = buildFakeMessage(user, 'some random message');
    await handleDmMessage(msg);

    const afterCount = (db.prepare('SELECT COUNT(*) as n FROM application_answers').get() as { n: number }).n;
    expect(afterCount).toBe(beforeCount);
  });

  // =========================================================================
  // Deferred: submit path (application:confirm: button → submitApplication)
  // =========================================================================
  // submitApplication creates Discord text channels and forum posts, which
  // requires discord:true seeding and a live bot session.  That path is tested
  // manually against the sandbox guild and is not automated here.
});

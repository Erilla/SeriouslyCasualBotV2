import { describe, it, expect, beforeEach } from 'vitest';
import type { ChatInputCommandInteraction, TextBasedChannel } from 'discord.js';
import { getE2EContext } from '../setup/bootstrap.js';
import { fakeChatInput } from '../setup/synthesizer.js';
import { resetAndSeed } from '../setup/baseline.js';
import { getDatabase } from '../../../src/database/db.js';
import applyCmd from '../../../src/commands/apply.js';

// ---------------------------------------------------------------------------
// Helper: extract reply content string from a FakeReply.
// ---------------------------------------------------------------------------
function replyContent(reply: { options: unknown }): string {
  const opts = reply.options;
  if (typeof opts === 'string') return opts;
  return (opts as { content?: string }).content ?? '';
}

// ---------------------------------------------------------------------------
// Helper: extract editReply content string.
// ---------------------------------------------------------------------------
function editContent(reply: { options: unknown } | null): string {
  if (!reply) return '';
  const opts = reply.options;
  if (typeof opts === 'string') return opts;
  return (opts as { content?: string }).content ?? '';
}

// ---------------------------------------------------------------------------
// describe
// ---------------------------------------------------------------------------
describe('/apply', () => {
  beforeEach(async () => {
    await resetAndSeed({ discord: false });
  });

  // =========================================================================
  // Happy path — fresh user (no in_progress application)
  // =========================================================================

  it('fresh user — replies ephemeral with "Check your DMs!" immediately', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    // Use tester as the applicant; no in_progress application exists after resetAndSeed.
    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.tester,
      user: ctx.tester.user,
      commandName: 'apply',
    });

    await applyCmd.execute(iact as unknown as ChatInputCommandInteraction);

    // The handler always sends the ephemeral ack first.
    expect(iact.__replies.length).toBe(1);
    const reply = iact.__replies[0]!;
    expect(reply.ephemeral).toBe(true);
    expect(replyContent(reply)).toContain('Check your DMs');
  });

  it('fresh user — does NOT show a modal (DM flow, not modal flow)', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.tester,
      user: ctx.tester.user,
      commandName: 'apply',
    });

    await applyCmd.execute(iact as unknown as ChatInputCommandInteraction);

    // /apply uses a DM questionnaire, not a modal.
    expect(iact.__modalShown).toBeNull();
  });

  it('fresh user — creates an in_progress application record in the DB', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const userId = ctx.tester.user.id;

    // Verify no in_progress application exists before invocation.
    const db = getDatabase();
    const before = db
      .prepare("SELECT id FROM applications WHERE applicant_user_id = ? AND status = 'in_progress'")
      .get(userId);
    expect(before).toBeUndefined();

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.tester,
      user: ctx.tester.user,
      commandName: 'apply',
    });

    await applyCmd.execute(iact as unknown as ChatInputCommandInteraction);

    // After invocation an in_progress record should exist (DM send may or may not fail,
    // but the DB row is written before the user.send() attempt).
    // If DM send fails the row is abandoned; if it succeeds the row stays in_progress.
    // Either way the row is created. Check either status.
    const after = db
      .prepare("SELECT status FROM applications WHERE applicant_user_id = ?")
      .get(userId) as { status: string } | undefined;
    expect(after).toBeDefined();
    expect(['in_progress', 'abandoned']).toContain(after!.status);
  });

  // =========================================================================
  // Existing in_progress application — resume path
  // =========================================================================

  it('user with existing in_progress application — still replies ephemeral "Check your DMs!"', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const userId = ctx.tester.user.id;
    const db = getDatabase();

    // Seed an in_progress application for the tester.
    // Requires at least one question (guaranteed by resetAndSeed's 9 questions).
    const firstQuestion = db
      .prepare('SELECT id FROM application_questions ORDER BY sort_order LIMIT 1')
      .get() as { id: number } | undefined;
    expect(firstQuestion).toBeDefined();

    db.prepare(
      'INSERT INTO applications (applicant_user_id, status, current_question_id) VALUES (?, ?, ?)',
    ).run(userId, 'in_progress', firstQuestion!.id);

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.tester,
      user: ctx.tester.user,
      commandName: 'apply',
    });

    await applyCmd.execute(iact as unknown as ChatInputCommandInteraction);

    // The handler's first action is always the same ephemeral ack.
    expect(iact.__replies.length).toBe(1);
    const reply = iact.__replies[0]!;
    expect(reply.ephemeral).toBe(true);
    expect(replyContent(reply)).toContain('Check your DMs');
  });

  // =========================================================================
  // DM failure path — startApplication returns false
  // =========================================================================

  it('DM failure — editReply contains failure message when startApplication returns false', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    // Simulate DM failure by using an applicant whose user.send() we override.
    // We wrap the tester user to throw on .send(), mimicking closed DMs.
    const originalSend = ctx.tester.user.send.bind(ctx.tester.user);
    const blockedUser = Object.create(ctx.tester.user) as typeof ctx.tester.user;
    blockedUser.send = async () => {
      throw new Error('Cannot send messages to this user');
    };

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.tester,
      user: blockedUser,
      commandName: 'apply',
    });

    await applyCmd.execute(iact as unknown as ChatInputCommandInteraction);

    // The initial ack is still sent.
    expect(iact.__replies.length).toBe(1);
    expect(iact.__replies[0]!.ephemeral).toBe(true);

    // The handler edits the reply to report the failure.
    expect(iact.__editedReply).not.toBeNull();
    const editText = editContent(iact.__editedReply);
    expect(editText).toContain('Failed to start application');

    // Restore (not strictly necessary since resetAndSeed runs next, but clean practice).
    blockedUser.send = originalSend;
  });
});

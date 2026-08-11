import { describe, it, expect, beforeEach } from 'vitest';
import type { ChatInputCommandInteraction, TextBasedChannel } from 'discord.js';
import { getE2EContext } from '../setup/bootstrap.js';
import { fakeChatInput } from '../setup/synthesizer.js';
import { resetAndSeed } from '../setup/baseline.js';
import { queryOne } from '../setup/assertions.js';
import { getDatabase } from '../../../src/database/db.js';
import { seedApplicationVariety } from '../../../src/functions/testdata/seedApplicationVariety.js';
import applicationsCmd from '../../../src/commands/applications.js';

// ---------------------------------------------------------------------------
// Helper: extract reply content string from a FakeReply.
// ---------------------------------------------------------------------------
function replyContent(reply: { options: unknown }): string {
  const opts = reply.options;
  if (typeof opts === 'string') return opts;
  return (opts as { content?: string }).content ?? '';
}

// ---------------------------------------------------------------------------
// Helper: extract the first embed's description from a FakeReply.
// ---------------------------------------------------------------------------
function firstEmbedDescription(reply: { options: unknown }): string {
  const opts = reply.options as { embeds?: Array<{ data?: { description?: string } }> };
  return opts.embeds?.[0]?.data?.description ?? '';
}

// ---------------------------------------------------------------------------
// Helper: get the id of a seeded application question by sort_order.
// ---------------------------------------------------------------------------
function getQuestionIdBySortOrder(sortOrder: number): number | null {
  const row = queryOne<{ id: number }>(
    'SELECT id FROM application_questions WHERE sort_order = ?',
    [sortOrder],
  );
  return row?.id ?? null;
}

// ---------------------------------------------------------------------------
// describe
// ---------------------------------------------------------------------------
describe('/applications', () => {
  beforeEach(async () => {
    await resetAndSeed();
  });

  // =========================================================================
  // list_questions
  // =========================================================================

  it('list_questions — replies ephemeral with the 9 seeded application questions', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'applications',
      subcommand: 'list_questions',
    });

    await applicationsCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.__replies.length).toBe(1);
    const reply = iact.__replies[0]!;
    expect(reply.ephemeral).toBe(true);

    const content = replyContent(reply);
    expect(content).toContain('Application Questions');
    // The first seeded question mentions class/spec.
    expect(content).toContain('class');
    // Entries are formatted as "**id.** (order: N) question text".
    expect(content).toMatch(/\*\*\d+\.\*\*/);
  });

  it('list_questions — replies with "No questions configured" when table is empty', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    // Remove all questions. Delete answers first to avoid FK violation.
    const db = getDatabase();
    db.prepare('DELETE FROM application_answers').run();
    db.prepare('DELETE FROM application_questions').run();

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'applications',
      subcommand: 'list_questions',
    });

    await applicationsCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.__replies.length).toBe(1);
    const reply = iact.__replies[0]!;
    expect(reply.ephemeral).toBe(true);
    const content = replyContent(reply);
    expect(content).toContain('No application questions configured');
  });

  // =========================================================================
  // add_question
  // =========================================================================

  it('add_question — adds a new question and replies ephemeral with confirmation', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const newQuestion = 'What is your favourite raiding memory?';

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'applications',
      subcommand: 'add_question',
      options: { question: newQuestion },
    });

    await applicationsCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.__replies.length).toBe(1);
    const reply = iact.__replies[0]!;
    expect(reply.ephemeral).toBe(true);
    const content = replyContent(reply);
    expect(content).toContain('Added question');
    expect(content).toContain(newQuestion);

    // DB: question must now exist.
    const row = queryOne<{ question: string }>(
      'SELECT question FROM application_questions WHERE question = ?',
      [newQuestion],
    );
    expect(row?.question).toBe(newQuestion);
  });

  it('add_question — new question receives the next sort_order after existing 9', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'applications',
      subcommand: 'add_question',
      options: { question: 'A new extra question' },
    });

    await applicationsCmd.execute(iact as unknown as ChatInputCommandInteraction);

    // The 9 seeded questions have sort_order 1..9, so the new one should be 10.
    const row = queryOne<{ sort_order: number }>(
      "SELECT sort_order FROM application_questions WHERE question = 'A new extra question'",
    );
    expect(row?.sort_order).toBe(10);
  });

  // =========================================================================
  // remove_question
  // =========================================================================

  it('remove_question — removes an existing question and replies with confirmation', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    // Get the ID of question at sort_order 9 (the last seeded one).
    const qId = getQuestionIdBySortOrder(9);
    expect(qId).not.toBeNull();

    // Remove answers referencing this question so there is no FK violation.
    const db = getDatabase();
    db.prepare('DELETE FROM application_answers WHERE question_id = ?').run(qId);

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'applications',
      subcommand: 'remove_question',
      options: { id: qId },
    });

    await applicationsCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.__replies.length).toBe(1);
    const reply = iact.__replies[0]!;
    expect(reply.ephemeral).toBe(true);
    const content = replyContent(reply);
    expect(content).toContain(`Removed question #${qId}`);

    // DB: question must be gone.
    const row = queryOne('SELECT id FROM application_questions WHERE id = ?', [qId]);
    expect(row).toBeUndefined();
  });

  it('remove_question — replies with "not found" when ID does not exist', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'applications',
      subcommand: 'remove_question',
      options: { id: 999999 },
    });

    await applicationsCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.__replies.length).toBe(1);
    const reply = iact.__replies[0]!;
    expect(reply.ephemeral).toBe(true);
    const content = replyContent(reply);
    expect(content).toContain('not found');
  });

  // =========================================================================
  // post_apply_button
  // =========================================================================

  it('post_apply_button — replies ephemeral with "Apply button posted!" and sends embed to channel', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'applications',
      subcommand: 'post_apply_button',
    });

    await applicationsCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.__replies.length).toBe(1);
    const reply = iact.__replies[0]!;
    expect(reply.ephemeral).toBe(true);
    const content = replyContent(reply);
    expect(content).toContain('Apply button posted');
  });

  // =========================================================================
  // view_pending
  // =========================================================================

  it('view_pending — replies ephemeral with embed listing pending seeded applications', async () => {
    // seed_all seeds 1 'active' application, which *is* pending.
    // We add variety data on top: its in_progress, active and abandoned rows are
    // pending too. view_pending filters for 'in_progress', 'active', 'abandoned'.
    const db = getDatabase();
    seedApplicationVariety(db);

    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'applications',
      subcommand: 'view_pending',
    });

    await applicationsCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.__replies.length).toBe(1);
    const reply = iact.__replies[0]!;
    expect(reply.ephemeral).toBe(true);

    // The reply should carry an embed (single page — 2 apps fit easily).
    const opts = reply.options as { embeds?: unknown[] };
    expect(opts.embeds).toBeDefined();
    expect(opts.embeds!.length).toBeGreaterThan(0);

    const desc = firstEmbedDescription(reply);
    // InProgressChar is seeded by seedApplicationVariety with status 'in_progress'.
    expect(desc).toContain('InProgressChar');
    // ActiveChar is seeded by seedApplicationVariety with status 'active'.
    expect(desc).toContain('ActiveChar');
    // AbandonedChar is seeded by seedApplicationVariety with status 'abandoned'.
    expect(desc).toContain('AbandonedChar');
  });

  it('view_pending — title includes "Pending Applications" and the count', async () => {
    // Add variety data so we have pending apps.
    const db = getDatabase();
    seedApplicationVariety(db);

    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'applications',
      subcommand: 'view_pending',
    });

    await applicationsCmd.execute(iact as unknown as ChatInputCommandInteraction);

    const replyObj = iact.__replies[0]!;
    const embedData = replyObj.options as { embeds?: Array<{ data?: { title?: string } }> };
    const title = embedData.embeds?.[0]?.data?.title ?? '';
    expect(title).toContain('Pending Applications');
    // seed_all's own 'active' application plus variety's in_progress, active and
    // abandoned rows = 4 pending.
    const pending = queryOne<{ count: number }>(
      "SELECT COUNT(*) as count FROM applications WHERE status IN ('in_progress', 'active', 'abandoned')",
    );
    expect(pending!.count).toBe(4);
    expect(title).toContain(String(pending!.count));
  });

  it('view_pending — replies with "No pending applications" when only non-pending apps exist', async () => {
    // seed_all leaves one 'active' application behind, which *is* pending — so the
    // baseline has to be resolved before this case exists at all. Resolve rather
    // than delete, so a non-pending application is still present to be ignored.
    getDatabase()
      .prepare(
        `UPDATE applications SET status = 'rejected', resolved_at = datetime('now')
          WHERE status IN ('in_progress', 'active', 'abandoned')`,
      )
      .run();

    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'applications',
      subcommand: 'view_pending',
    });

    await applicationsCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.__replies.length).toBe(1);
    const reply = iact.__replies[0]!;
    expect(reply.ephemeral).toBe(true);
    const content = replyContent(reply);
    expect(content).toContain('No pending applications');
  });

  // =========================================================================
  // set_accept_message
  // =========================================================================

  it('set_accept_message — shows modal with customId "application:modal:accept_message"', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'applications',
      subcommand: 'set_accept_message',
    });

    await applicationsCmd.execute(iact as unknown as ChatInputCommandInteraction);

    // Handler calls showModal — no reply.
    expect(iact.__replies.length).toBe(0);
    expect(iact.__modalShown).not.toBeNull();
    expect(iact.__modalShown!.data.custom_id).toBe('application:modal:accept_message');
    expect(iact.__modalShown!.data.title).toBe('Set Accept Message');
  });

  // =========================================================================
  // set_reject_message
  // =========================================================================

  it('set_reject_message — shows modal with customId "application:modal:reject_message"', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'applications',
      subcommand: 'set_reject_message',
    });

    await applicationsCmd.execute(iact as unknown as ChatInputCommandInteraction);

    // Handler calls showModal — no reply.
    expect(iact.__replies.length).toBe(0);
    expect(iact.__modalShown).not.toBeNull();
    expect(iact.__modalShown!.data.custom_id).toBe('application:modal:reject_message');
    expect(iact.__modalShown!.data.title).toBe('Set Reject Message');
  });
});

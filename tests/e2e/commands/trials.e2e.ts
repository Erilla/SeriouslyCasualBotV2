import { describe, it, expect, beforeEach } from 'vitest';
import type { ChatInputCommandInteraction, TextBasedChannel } from 'discord.js';
import { getE2EContext } from '../setup/bootstrap.js';
import { fakeChatInput } from '../setup/synthesizer.js';
import { resetAndSeed } from '../setup/baseline.js';
import { queryOne } from '../setup/assertions.js';
import trialsCmd from '../../../src/commands/trials.js';

// ---------------------------------------------------------------------------
// Helper: extract reply content string from a FakeReply.
// ---------------------------------------------------------------------------
function replyContent(reply: { options: unknown }): string {
  const opts = reply.options;
  if (typeof opts === 'string') return opts;
  return (opts as { content?: string }).content ?? '';
}

// ---------------------------------------------------------------------------
// Helper: extract first embed description from a FakeReply.
// ---------------------------------------------------------------------------
function firstEmbedDescription(reply: { options: unknown }): string {
  const opts = reply.options as { embeds?: Array<{ data?: { description?: string } }> };
  return opts.embeds?.[0]?.data?.description ?? '';
}

// ---------------------------------------------------------------------------
// Helper: get the thread_id for the seeded trial.
// ---------------------------------------------------------------------------
function getSeededTrialThreadId(): string | null {
  const row = queryOne<{ thread_id: string | null }>(
    "SELECT thread_id FROM trials WHERE status = 'active' LIMIT 1",
  );
  return row?.thread_id ?? null;
}

// ---------------------------------------------------------------------------
// Helper: get the id for the seeded trial.
// ---------------------------------------------------------------------------
function getSeededTrialId(): number | null {
  const row = queryOne<{ id: number }>(
    "SELECT id FROM trials WHERE status = 'active' LIMIT 1",
  );
  return row?.id ?? null;
}

describe('/trials', () => {
  beforeEach(async () => {
    await resetAndSeed();
  });

  // =========================================================================
  // create_thread
  // =========================================================================

  it('create_thread — shows a modal with customId "trial:modal:create"', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'trials',
      subcommand: 'create_thread',
    });

    await trialsCmd.execute(iact as unknown as ChatInputCommandInteraction);

    // No reply: the handler only shows a modal.
    expect(iact.__replies.length).toBe(0);
    expect(iact.__modalShown).not.toBeNull();
    expect(iact.__modalShown!.data.custom_id).toBe('trial:modal:create');
    expect(iact.__modalShown!.data.title).toBe('Create Trial Review');
  });

  it('create_thread — modal has character_name, role, and start_date fields', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'trials',
      subcommand: 'create_thread',
    });

    await trialsCmd.execute(iact as unknown as ChatInputCommandInteraction);

    const modal = iact.__modalShown!;
    // ActionRow components contain TextInput components.
    const components = modal.components;
    const customIds = components.flatMap((row) =>
      row.components.map((c) => (c as { data: { custom_id: string } }).data.custom_id),
    );
    expect(customIds).toContain('character_name');
    expect(customIds).toContain('role');
    expect(customIds).toContain('start_date');
  });

  // =========================================================================
  // get_current_trials
  // =========================================================================

  it('get_current_trials — returns embed listing the seeded active trial', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    // Confirm the DB has exactly 1 active trial.
    const dbRow = queryOne<{ count: number }>(
      "SELECT COUNT(*) as count FROM trials WHERE status IN ('active', 'promoted')",
    );
    expect(dbRow!.count).toBe(1);

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'trials',
      subcommand: 'get_current_trials',
    });

    await trialsCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.__replies.length).toBe(1);
    const reply = iact.__replies[0]!;
    expect(reply.ephemeral).toBe(true);

    // Embed must be present.
    const opts = reply.options as { embeds?: unknown[] };
    expect(opts.embeds).toBeDefined();
    expect(opts.embeds!.length).toBeGreaterThan(0);
  });

  it('get_current_trials — embed description mentions "Testcharacter"', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'trials',
      subcommand: 'get_current_trials',
    });

    await trialsCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.__replies.length).toBe(1);
    const desc = firstEmbedDescription(iact.__replies[0]!);
    expect(desc).toContain('Testcharacter');
  });

  it('get_current_trials — replies with "No active trials." when no active trials exist', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    // Close all active trials in the DB directly so the handler sees an empty list.
    const { getDatabase } = await import('../../../src/database/db.js');
    getDatabase().prepare("UPDATE trials SET status = 'closed'").run();

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'trials',
      subcommand: 'get_current_trials',
    });

    await trialsCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.__replies.length).toBe(1);
    const reply = iact.__replies[0]!;
    expect(reply.ephemeral).toBe(true);
    const content = replyContent(reply);
    expect(content).toContain('No active trials.');
  });

  // =========================================================================
  // remove_trial
  // =========================================================================

  it('remove_trial — replies with "No trial found" when thread_id does not match any trial', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'trials',
      subcommand: 'remove_trial',
      options: { thread_id: '000000000000000000' },
    });

    await trialsCmd.execute(iact as unknown as ChatInputCommandInteraction);

    // No defer: early return via reply().
    expect(iact.__replies.length).toBe(1);
    const content = replyContent(iact.__replies[0]!);
    expect(content).toContain('No trial found');
    expect(content).toContain('000000000000000000');

    // DB: trial status must be unchanged.
    const row = queryOne<{ status: string }>(
      "SELECT status FROM trials WHERE status = 'active' LIMIT 1",
    );
    expect(row?.status).toBe('active');
  });

  it('remove_trial — closes the trial (sets status=closed) and edits reply with success', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    // Get the seeded trial thread_id.
    const threadId = getSeededTrialThreadId();
    expect(threadId).not.toBeNull();

    const trialId = getSeededTrialId();
    expect(trialId).not.toBeNull();

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'trials',
      subcommand: 'remove_trial',
      options: { thread_id: threadId! },
    });

    await trialsCmd.execute(iact as unknown as ChatInputCommandInteraction);

    // Handler defers then editReplies.
    expect(iact.__deferred).not.toBeNull();
    expect(iact.__deferred!.ephemeral).toBe(true);
    expect(iact.__editedReply).not.toBeNull();
    const content = replyContent(iact.__editedReply!);
    expect(content).toContain('Testcharacter');
    expect(content).toMatch(/[Cc]losed trial/);

    // DB: trial must now be closed.
    const row = queryOne<{ status: string }>(
      'SELECT status FROM trials WHERE id = ?',
      [trialId!],
    );
    expect(row?.status).toBe('closed');
  });

  // =========================================================================
  // change_trial_info
  // =========================================================================

  it('change_trial_info — replies with error if no fields provided', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const threadId = getSeededTrialThreadId();
    expect(threadId).not.toBeNull();

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'trials',
      subcommand: 'change_trial_info',
      options: { thread_id: threadId! },
      // No character_name, role, or start_date provided.
    });

    await trialsCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.__replies.length).toBe(1);
    const content = replyContent(iact.__replies[0]!);
    expect(content).toContain('at least one field');
  });

  it('change_trial_info — replies with error for invalid date format', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const threadId = getSeededTrialThreadId();
    expect(threadId).not.toBeNull();

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'trials',
      subcommand: 'change_trial_info',
      options: { thread_id: threadId!, start_date: 'not-a-date' },
    });

    await trialsCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.__replies.length).toBe(1);
    const content = replyContent(iact.__replies[0]!);
    expect(content).toContain('Invalid date format');
  });

  it('change_trial_info — replies with "No trial found" for unknown thread_id', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'trials',
      subcommand: 'change_trial_info',
      options: { thread_id: '000000000000000000', role: 'Tank' },
    });

    await trialsCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.__replies.length).toBe(1);
    const content = replyContent(iact.__replies[0]!);
    expect(content).toContain('No trial found');
  });

  it('change_trial_info — updates role in DB and edits reply with success', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const threadId = getSeededTrialThreadId();
    expect(threadId).not.toBeNull();

    const trialId = getSeededTrialId();
    expect(trialId).not.toBeNull();

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'trials',
      subcommand: 'change_trial_info',
      options: { thread_id: threadId!, role: 'Healer' },
    });

    await trialsCmd.execute(iact as unknown as ChatInputCommandInteraction);

    // Handler defers then edits reply.
    expect(iact.__deferred).not.toBeNull();
    expect(iact.__editedReply).not.toBeNull();
    const content = replyContent(iact.__editedReply!);
    expect(content).toContain('Trial info updated');

    // DB: role must have changed.
    const row = queryOne<{ role: string }>(
      'SELECT role FROM trials WHERE id = ?',
      [trialId!],
    );
    expect(row?.role).toBe('Healer');
  });

  // =========================================================================
  // update_trial_logs
  // =========================================================================

  it(
    'update_trial_logs — defers, calls WarcraftLogs, edits reply with result',
    { timeout: 120_000 }, // real WarcraftLogs API
    async () => {
      const ctx = getE2EContext();
      const channel = ctx.guild.systemChannel as TextBasedChannel;

      const iact = fakeChatInput({
        client: ctx.client,
        guild: ctx.guild,
        channel,
        member: ctx.officer,
        user: ctx.officer.user,
        commandName: 'trials',
        subcommand: 'update_trial_logs',
      });

      await trialsCmd.execute(iact as unknown as ChatInputCommandInteraction);

      // Handler always defers first.
      expect(iact.__deferred).not.toBeNull();
      expect(iact.__deferred!.ephemeral).toBe(true);

      // After the API call, editReply must be called.
      expect(iact.__editedReply).not.toBeNull();
      const content = replyContent(iact.__editedReply!);
      expect(content).toContain('Trial logs updated');
    },
  );

  // =========================================================================
  // update_trial_review_messages
  // =========================================================================

  it('update_trial_review_messages — defers and edits reply with count summary', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'trials',
      subcommand: 'update_trial_review_messages',
    });

    await trialsCmd.execute(iact as unknown as ChatInputCommandInteraction);

    // Handler always defers first.
    expect(iact.__deferred).not.toBeNull();
    expect(iact.__deferred!.ephemeral).toBe(true);

    // editReply must be called with a count summary.
    expect(iact.__editedReply).not.toBeNull();
    const content = replyContent(iact.__editedReply!);
    // Either "Updated N review messages" or "No active trials to update".
    expect(content).toMatch(/[Uu]pdated \d+ review messages|No active trials to update/);
  });

  it('update_trial_review_messages — edits reply with "No active trials to update" when no active trials', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    // Close all active trials in DB directly.
    const { getDatabase } = await import('../../../src/database/db.js');
    getDatabase().prepare("UPDATE trials SET status = 'closed'").run();

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'trials',
      subcommand: 'update_trial_review_messages',
    });

    await trialsCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.__deferred).not.toBeNull();
    expect(iact.__editedReply).not.toBeNull();
    const content = replyContent(iact.__editedReply!);
    expect(content).toContain('No active trials to update');
  });
});

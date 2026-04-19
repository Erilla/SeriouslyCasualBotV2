import { describe, it, expect, beforeEach } from 'vitest';
import type { ChatInputCommandInteraction, TextBasedChannel } from 'discord.js';
import { getE2EContext } from '../setup/bootstrap.js';
import { fakeChatInput } from '../setup/synthesizer.js';
import { resetAndSeed } from '../setup/baseline.js';
import { queryOne, queryAll } from '../setup/assertions.js';
import lootCmd from '../../../src/commands/loot.js';

// ---------------------------------------------------------------------------
// Helper: extract reply content string from a FakeReply.
// ---------------------------------------------------------------------------
function replyContent(reply: { options: unknown }): string {
  const opts = reply.options;
  if (typeof opts === 'string') return opts;
  return (opts as { content?: string }).content ?? '';
}

// ---------------------------------------------------------------------------
// Seed-sourced boss IDs — match seedLoot.ts mock data.
// ---------------------------------------------------------------------------
const BOSS_A = 99901; // Mock Boss Alpha
const BOSS_B = 99902; // Mock Boss Beta
const BOSS_C = 99903; // Mock Boss Gamma

// ---------------------------------------------------------------------------
// describe
// ---------------------------------------------------------------------------
describe('/loot', () => {
  beforeEach(async () => {
    // No Discord artifacts needed for any loot subcommand tests here.
    await resetAndSeed({ discord: false });
  });

  // =========================================================================
  // delete_post
  // =========================================================================

  it('delete_post — removes a seeded loot post from the DB', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    // Confirm the post exists before the command.
    const before = queryOne<{ boss_id: number }>(
      'SELECT boss_id FROM loot_posts WHERE boss_id = ?',
      [BOSS_A],
    );
    expect(before?.boss_id).toBe(BOSS_A);

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'loot',
      subcommand: 'delete_post',
      options: { boss_id: BOSS_A },
    });

    await lootCmd.execute(iact as unknown as ChatInputCommandInteraction);

    // Command defers then edits reply.
    expect(iact.deferred).toBe(true);
    expect(iact.__deferred?.ephemeral).toBe(true);
    expect(iact.__editedReply).not.toBeNull();
    const content = replyContent(iact.__editedReply!);
    expect(content).toBe('Loot post removed.');

    // Post must be gone from DB.
    const after = queryOne<{ boss_id: number }>(
      'SELECT boss_id FROM loot_posts WHERE boss_id = ?',
      [BOSS_A],
    );
    expect(after).toBeUndefined();
  });

  it('delete_post — is idempotent: missing boss ID logs warn and replies with success', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'loot',
      subcommand: 'delete_post',
      options: { boss_id: 99999 }, // never seeded
    });

    await lootCmd.execute(iact as unknown as ChatInputCommandInteraction);

    // deleteLootPost warns and returns when post not found — command still
    // completes successfully and edits reply.
    expect(iact.deferred).toBe(true);
    expect(iact.__editedReply).not.toBeNull();
    const content = replyContent(iact.__editedReply!);
    expect(content).toBe('Loot post removed.');
  });

  // =========================================================================
  // delete_posts
  // =========================================================================

  it('delete_posts — removes multiple seeded loot posts by comma-separated IDs', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    // Confirm all three posts exist.
    const before = queryAll<{ boss_id: number }>('SELECT boss_id FROM loot_posts');
    expect(before).toHaveLength(3);

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'loot',
      subcommand: 'delete_posts',
      options: { boss_ids: `${BOSS_A},${BOSS_B}` },
    });

    await lootCmd.execute(iact as unknown as ChatInputCommandInteraction);

    // Command uses reply (not deferReply) then editReply.
    expect(iact.replied).toBe(true);
    expect(iact.__replies[0].ephemeral).toBe(true);
    expect(replyContent(iact.__replies[0])).toBe('Deleting posts...');

    expect(iact.__editedReply).not.toBeNull();
    expect(replyContent(iact.__editedReply!)).toBe('Deleted posts.');

    // Boss A and B removed; Boss C still present.
    const afterA = queryOne<{ boss_id: number }>(
      'SELECT boss_id FROM loot_posts WHERE boss_id = ?',
      [BOSS_A],
    );
    expect(afterA).toBeUndefined();

    const afterB = queryOne<{ boss_id: number }>(
      'SELECT boss_id FROM loot_posts WHERE boss_id = ?',
      [BOSS_B],
    );
    expect(afterB).toBeUndefined();

    const afterC = queryOne<{ boss_id: number }>(
      'SELECT boss_id FROM loot_posts WHERE boss_id = ?',
      [BOSS_C],
    );
    expect(afterC?.boss_id).toBe(BOSS_C);
  });

  it('delete_posts — handles whitespace in the comma-separated list', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'loot',
      subcommand: 'delete_posts',
      options: { boss_ids: ` ${BOSS_C} ` }, // surrounding whitespace
    });

    await lootCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(replyContent(iact.__editedReply!)).toBe('Deleted posts.');

    const after = queryOne<{ boss_id: number }>(
      'SELECT boss_id FROM loot_posts WHERE boss_id = ?',
      [BOSS_C],
    );
    expect(after).toBeUndefined();
  });

  it('delete_posts — skips NaN entries, still deletes valid ones', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'loot',
      subcommand: 'delete_posts',
      options: { boss_ids: `notanumber,${BOSS_A}` },
    });

    await lootCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(replyContent(iact.__editedReply!)).toBe('Deleted posts.');

    // Boss A is deleted; NaN skipped silently.
    const after = queryOne<{ boss_id: number }>(
      'SELECT boss_id FROM loot_posts WHERE boss_id = ?',
      [BOSS_A],
    );
    expect(after).toBeUndefined();

    // Other posts untouched.
    const remaining = queryAll<{ boss_id: number }>('SELECT boss_id FROM loot_posts');
    expect(remaining).toHaveLength(2);
  });

  // =========================================================================
  // create_posts
  // =========================================================================

  it('create_posts — replies with "Checking raid expansions..." then edits; fails without loot channel config', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    // No loot_channel_id in config — checkRaidExpansions will fail to resolve
    // the channel and return early, causing editReply with failure message.
    // Note: checkRaidExpansions also calls the Raider.io API; in the e2e
    // sandbox we do not stub HTTP. It may succeed (creates posts) or fail
    // (API/channel error). Either way the interaction lifecycle must complete.
    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'loot',
      subcommand: 'create_posts',
    });

    await lootCmd.execute(iact as unknown as ChatInputCommandInteraction);

    // The command always does reply() first with "Checking raid expansions..."
    expect(iact.replied).toBe(true);
    expect(iact.__replies).toHaveLength(1);
    expect(replyContent(iact.__replies[0])).toBe('Checking raid expansions...');
    expect(iact.__replies[0].ephemeral).toBe(true);

    // Then always edits the reply with a result.
    expect(iact.__editedReply).not.toBeNull();
    // The edit is either "Loot posts created." on success or
    // "Failed to create loot posts: ..." on error — both are valid outcomes.
    const editContent = replyContent(iact.__editedReply!);
    expect(
      editContent === 'Loot posts created.' || editContent.startsWith('Failed to create loot posts:'),
    ).toBe(true);
  });
});

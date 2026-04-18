import { describe, it, expect, beforeEach } from 'vitest';
import type { ChatInputCommandInteraction, TextBasedChannel } from 'discord.js';
import { getE2EContext } from '../setup/bootstrap.js';
import { fakeChatInput } from '../setup/synthesizer.js';
import { resetAndSeed } from '../setup/baseline.js';
import { queryOne, queryAll } from '../setup/assertions.js';
import { getDatabase } from '../../../src/database/db.js';
import raidersCmd from '../../../src/commands/raiders.js';

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
// Helper: insert a fresh raider with no EPGP data (for FK-safe ignore tests).
// ---------------------------------------------------------------------------
function insertFreshRaider(characterName: string): void {
  const db = getDatabase();
  db.prepare(
    `INSERT OR IGNORE INTO raiders (character_name, realm, region, rank, class)
     VALUES (?, 'silvermoon', 'eu', 3, 'Warrior')`,
  ).run(characterName);
}

// ---------------------------------------------------------------------------
// Helper: insert an ignored character directly (for remove_ignore tests).
// ---------------------------------------------------------------------------
function insertIgnoredCharacter(characterName: string): void {
  const db = getDatabase();
  db.prepare('INSERT OR IGNORE INTO ignored_characters (character_name) VALUES (?)').run(characterName);
}

// ---------------------------------------------------------------------------
// describe
// ---------------------------------------------------------------------------
describe('/raiders', () => {
  beforeEach(async () => {
    await resetAndSeed();
  });

  // =========================================================================
  // get_raiders
  // =========================================================================

  it('get_raiders — replies with embed listing all 15 seeded raiders', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'raiders',
      subcommand: 'get_raiders',
    });

    await raidersCmd.execute(iact as unknown as ChatInputCommandInteraction);

    // Single page: exactly one reply, no editReply called.
    expect(iact.__replies.length).toBe(1);
    const reply = iact.__replies[0]!;

    // 15 raiders fit in one page — no buttons, no deferred.
    expect(iact.deferred).toBe(false);
    expect(iact.__editedReply).toBeNull();

    // The reply must carry at least one embed.
    const opts = reply.options as { embeds?: unknown[] };
    expect(opts.embeds).toBeDefined();
    expect(opts.embeds!.length).toBeGreaterThan(0);

    // The embed description must mention the seeded raiders.
    const desc = firstEmbedDescription(reply);
    expect(desc).toContain('Azerothian'); // first raider alphabetically after seed
    expect(desc).toContain('silvermoon'); // realm present
  });

  it('get_raiders — reply is NOT ephemeral (viewable by any admin)', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'raiders',
      subcommand: 'get_raiders',
    });

    await raidersCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.__replies.length).toBe(1);
    expect(iact.__replies[0]!.ephemeral).toBe(false);
  });

  // =========================================================================
  // get_ignored_characters
  // =========================================================================

  it('get_ignored_characters — reports no ignored characters on fresh seed', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'raiders',
      subcommand: 'get_ignored_characters',
    });

    await raidersCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.__replies.length).toBe(1);
    const reply = iact.__replies[0]!;
    expect(reply.ephemeral).toBe(true);
    const content = replyContent(reply);
    expect(content).toContain('Ignored Characters');
    expect(content).toContain('No ignored characters');
  });

  it('get_ignored_characters — lists a character that was previously ignored', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    // Pre-insert an ignored character directly (no FK deps on ignored_characters).
    insertIgnoredCharacter('Testignored');

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'raiders',
      subcommand: 'get_ignored_characters',
    });

    await raidersCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.__replies.length).toBe(1);
    const content = replyContent(iact.__replies[0]!);
    expect(content).toContain('Testignored');
  });

  // =========================================================================
  // ignore_character
  // =========================================================================

  it('ignore_character — succeeds for a raider with no EPGP data and adds to ignored list', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    // Insert a fresh raider that has no EPGP FK deps.
    insertFreshRaider('Freshraider');

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'raiders',
      subcommand: 'ignore_character',
      options: { character_name: 'Freshraider' },
    });

    await raidersCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.__replies.length).toBe(1);
    const reply = iact.__replies[0]!;
    expect(reply.ephemeral).toBe(true);
    const content = replyContent(reply);
    expect(content).toContain('Freshraider');
    expect(content).toContain('Ignored');

    // DB: raider removed from raiders table.
    const raiderRow = queryOne('SELECT id FROM raiders WHERE character_name = ?', ['Freshraider']);
    expect(raiderRow).toBeUndefined();

    // DB: character added to ignored_characters.
    const ignoredRow = queryOne('SELECT character_name FROM ignored_characters WHERE character_name = ?', ['Freshraider']);
    expect(ignoredRow).toBeDefined();
  });

  it('ignore_character — fails (FK constraint) for a seeded raider that has EPGP data', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    // 'Azerothian' is the first seeded raider and has EPGP rows — delete will fail FK.
    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'raiders',
      subcommand: 'ignore_character',
      options: { character_name: 'Azerothian' },
    });

    await raidersCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.__replies.length).toBe(1);
    const reply = iact.__replies[0]!;
    expect(reply.ephemeral).toBe(true);
    const content = replyContent(reply);
    expect(content).toContain('Failed to ignore');

    // DB: raider must still exist (transaction was rolled back).
    const raiderRow = queryOne('SELECT character_name FROM raiders WHERE character_name = ?', ['Azerothian']);
    expect(raiderRow).toBeDefined();
  });

  // =========================================================================
  // remove_ignore_character
  // =========================================================================

  it('remove_ignore_character — removes an existing ignored character and confirms in reply', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    // Pre-seed an ignored character.
    insertIgnoredCharacter('Ignoredbefore');

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'raiders',
      subcommand: 'remove_ignore_character',
      options: { character_name: 'Ignoredbefore' },
    });

    await raidersCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.__replies.length).toBe(1);
    const reply = iact.__replies[0]!;
    expect(reply.ephemeral).toBe(true);
    const content = replyContent(reply);
    expect(content).toContain('Ignoredbefore');
    expect(content).toContain('Removed');

    // DB: row should be gone.
    const row = queryOne('SELECT character_name FROM ignored_characters WHERE character_name = ?', ['Ignoredbefore']);
    expect(row).toBeUndefined();
  });

  it('remove_ignore_character — reports not-in-list when character was never ignored', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'raiders',
      subcommand: 'remove_ignore_character',
      options: { character_name: 'Neverignored' },
    });

    await raidersCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.__replies.length).toBe(1);
    const reply = iact.__replies[0]!;
    expect(reply.ephemeral).toBe(true);
    const content = replyContent(reply);
    expect(content).toContain('Neverignored');
    expect(content).toContain('not in the ignore list');
  });

  // =========================================================================
  // sync_raiders
  // =========================================================================

  it(
    'sync_raiders — replies with "Syncing raiders..." then edits to success or error message',
    { timeout: 60_000 }, // real raider.io API call
    async () => {
      const ctx = getE2EContext();
      const channel = ctx.guild.systemChannel as TextBasedChannel;

      const iact = fakeChatInput({
        client: ctx.client,
        guild: ctx.guild,
        channel,
        member: ctx.officer,
        user: ctx.officer.user,
        commandName: 'raiders',
        subcommand: 'sync_raiders',
      });

      await raidersCmd.execute(iact as unknown as ChatInputCommandInteraction);

      // Initial reply must be ephemeral with "Syncing" text.
      expect(iact.__replies.length).toBe(1);
      const reply = iact.__replies[0]!;
      expect(reply.ephemeral).toBe(true);
      const content = replyContent(reply);
      expect(content).toMatch(/Syncing raiders/i);

      // editReply must be called — either "sync complete" or "Sync failed:".
      expect(iact.__editedReply).not.toBeNull();
      const editedContent = replyContent(iact.__editedReply!);
      expect(editedContent).toMatch(/Raider sync complete|Sync failed/i);
    },
  );

  // =========================================================================
  // check_missing_users
  // =========================================================================

  it(
    'check_missing_users — finds all unlinked seeded raiders, runs auto-match, edits reply with counts',
    { timeout: 60_000 }, // real Discord API calls (guild.members.fetch + channel.send × N)
    async () => {
      const ctx = getE2EContext();
      const channel = ctx.guild.systemChannel as TextBasedChannel;

      const iact = fakeChatInput({
        client: ctx.client,
        guild: ctx.guild,
        channel,
        member: ctx.officer,
        user: ctx.officer.user,
        commandName: 'raiders',
        subcommand: 'check_missing_users',
      });

      await raidersCmd.execute(iact as unknown as ChatInputCommandInteraction);

      // Must have replied at least once.
      expect(iact.__replies.length).toBe(1);
      const reply = iact.__replies[0]!;
      expect(reply.ephemeral).toBe(true);
      const content = replyContent(reply);
      // Must mention finding unlinked raiders and running auto-match.
      expect(content).toMatch(/unlinked raiders/i);
      expect(content).toMatch(/auto-match/i);

      // editReply must be called with the final summary.
      expect(iact.__editedReply).not.toBeNull();
      const editedContent = replyContent(iact.__editedReply!);
      expect(editedContent).toMatch(/unlinked raiders/i);
      expect(editedContent).toMatch(/auto-matched/i);
    },
  );

  it('check_missing_users — reports "All raiders linked" when all have discord_user_id set', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    // Link all seeded raiders to a fake user_id so none appear unlinked.
    const db = getDatabase();
    db.prepare('UPDATE raiders SET discord_user_id = ? WHERE discord_user_id IS NULL').run(
      ctx.tester.id,
    );

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'raiders',
      subcommand: 'check_missing_users',
    });

    await raidersCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.__replies.length).toBe(1);
    const reply = iact.__replies[0]!;
    expect(reply.ephemeral).toBe(true);
    const content = replyContent(reply);
    expect(content).toMatch(/All raiders are linked/i);
  });

  // =========================================================================
  // update_raider_user
  // =========================================================================

  it('update_raider_user — links a seeded raider to the tester Discord user and persists to DB', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const characterName = 'Brightmane'; // seeded raider with no message_id initially

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'raiders',
      subcommand: 'update_raider_user',
      options: {
        character_name: characterName,
        user: ctx.tester.user,
      },
    });

    await raidersCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.__replies.length).toBe(1);
    const reply = iact.__replies[0]!;
    expect(reply.ephemeral).toBe(true);
    const content = replyContent(reply);
    expect(content).toContain(characterName);
    expect(content).toContain('Linked');

    // DB: raiders row must reflect the new discord_user_id.
    const row = queryOne<{ discord_user_id: string }>(
      'SELECT discord_user_id FROM raiders WHERE character_name = ?',
      [characterName],
    );
    expect(row?.discord_user_id).toBe(ctx.tester.id);

    // DB: raider_identity_map must have been upserted.
    const identityRow = queryOne<{ discord_user_id: string }>(
      'SELECT discord_user_id FROM raider_identity_map WHERE character_name = ?',
      [characterName],
    );
    expect(identityRow?.discord_user_id).toBe(ctx.tester.id);
  });

  it('update_raider_user — replies with failure when character does not exist in DB', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'raiders',
      subcommand: 'update_raider_user',
      options: {
        character_name: 'Doesnotexist',
        user: ctx.tester.user,
      },
    });

    await raidersCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.__replies.length).toBe(1);
    const reply = iact.__replies[0]!;
    expect(reply.ephemeral).toBe(true);
    const content = replyContent(reply);
    expect(content).toContain('Failed to link');
    expect(content).toContain('Doesnotexist');
  });

  // =========================================================================
  // add_overlord
  // =========================================================================

  it('add_overlord — inserts a new overlord and replies with confirmation', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'raiders',
      subcommand: 'add_overlord',
      options: {
        name: 'TestOverlord',
        user: ctx.tester.user,
      },
    });

    await raidersCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.__replies.length).toBe(1);
    const reply = iact.__replies[0]!;
    expect(reply.ephemeral).toBe(true);
    const content = replyContent(reply);
    expect(content).toContain('TestOverlord');
    expect(content).toContain('Added overlord');

    // DB: overlord row must exist.
    const row = queryOne<{ name: string; user_id: string }>(
      'SELECT name, user_id FROM overlords WHERE name = ?',
      ['TestOverlord'],
    );
    expect(row?.name).toBe('TestOverlord');
    expect(row?.user_id).toBe(ctx.tester.id);
  });

  it('add_overlord — fails gracefully when name is a duplicate', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    // Insert overlord once.
    const first = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'raiders',
      subcommand: 'add_overlord',
      options: { name: 'DupeOverlord', user: ctx.tester.user },
    });
    await raidersCmd.execute(first as unknown as ChatInputCommandInteraction);
    expect(first.__replies[0]!.ephemeral).toBe(true);
    expect(replyContent(first.__replies[0]!)).toContain('Added overlord');

    // Try to insert the same overlord again.
    const second = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'raiders',
      subcommand: 'add_overlord',
      options: { name: 'DupeOverlord', user: ctx.tester.user },
    });
    await raidersCmd.execute(second as unknown as ChatInputCommandInteraction);

    expect(second.__replies.length).toBe(1);
    const content = replyContent(second.__replies[0]!);
    expect(content).toContain('Failed to add overlord');
  });

  // =========================================================================
  // get_overlords
  // =========================================================================

  it('get_overlords — reports no overlords when table is empty', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'raiders',
      subcommand: 'get_overlords',
    });

    await raidersCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.__replies.length).toBe(1);
    const reply = iact.__replies[0]!;
    expect(reply.ephemeral).toBe(true);
    const content = replyContent(reply);
    expect(content).toContain('Overlords');
    expect(content).toContain('No overlords configured');
  });

  it('get_overlords — lists an overlord that was previously added', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    // Add overlord first.
    const addIact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'raiders',
      subcommand: 'add_overlord',
      options: { name: 'ListedOverlord', user: ctx.tester.user },
    });
    await raidersCmd.execute(addIact as unknown as ChatInputCommandInteraction);

    const getIact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'raiders',
      subcommand: 'get_overlords',
    });
    await raidersCmd.execute(getIact as unknown as ChatInputCommandInteraction);

    expect(getIact.__replies.length).toBe(1);
    const content = replyContent(getIact.__replies[0]!);
    expect(content).toContain('ListedOverlord');
  });

  // =========================================================================
  // remove_overlord
  // =========================================================================

  it('remove_overlord — removes an existing overlord and confirms in reply', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    // Add overlord first.
    const addIact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'raiders',
      subcommand: 'add_overlord',
      options: { name: 'ToRemoveOverlord', user: ctx.tester.user },
    });
    await raidersCmd.execute(addIact as unknown as ChatInputCommandInteraction);

    // Confirm it was added.
    const before = queryOne('SELECT name FROM overlords WHERE name = ?', ['ToRemoveOverlord']);
    expect(before).toBeDefined();

    // Now remove it.
    const removeIact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'raiders',
      subcommand: 'remove_overlord',
      options: { name: 'ToRemoveOverlord' },
    });
    await raidersCmd.execute(removeIact as unknown as ChatInputCommandInteraction);

    expect(removeIact.__replies.length).toBe(1);
    const reply = removeIact.__replies[0]!;
    expect(reply.ephemeral).toBe(true);
    const content = replyContent(reply);
    expect(content).toContain('ToRemoveOverlord');
    expect(content).toContain('Removed overlord');

    // DB: overlord row must be gone.
    const after = queryOne('SELECT name FROM overlords WHERE name = ?', ['ToRemoveOverlord']);
    expect(after).toBeUndefined();
  });

  it('remove_overlord — succeeds silently even when name was never an overlord', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    // The handler calls removeOverlord() which does DELETE (no error if row missing).
    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'raiders',
      subcommand: 'remove_overlord',
      options: { name: 'Phantomoverlord' },
    });

    await raidersCmd.execute(iact as unknown as ChatInputCommandInteraction);

    // removeOverlord() does not throw on missing row, so handler replies with success.
    expect(iact.__replies.length).toBe(1);
    const reply = iact.__replies[0]!;
    expect(reply.ephemeral).toBe(true);
    const content = replyContent(reply);
    expect(content).toContain('Removed overlord');
    expect(content).toContain('Phantomoverlord');
  });
});

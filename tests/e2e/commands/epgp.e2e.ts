import { describe, it, expect, beforeEach } from 'vitest';
import type { ChatInputCommandInteraction, TextBasedChannel } from 'discord.js';
import { getE2EContext } from '../setup/bootstrap.js';
import { fakeChatInput } from '../setup/synthesizer.js';
import { resetAndSeed } from '../setup/baseline.js';
import { queryOne, queryAll } from '../setup/assertions.js';
import { getDatabase } from '../../../src/database/db.js';
import epgpCmd from '../../../src/commands/epgp.js';

// ---------------------------------------------------------------------------
// Helper: extract reply content string from a FakeReply.
// ---------------------------------------------------------------------------
function replyContent(reply: { options: unknown }): string {
  const opts = reply.options;
  if (typeof opts === 'string') return opts;
  return (opts as { content?: string }).content ?? '';
}

// ---------------------------------------------------------------------------
// Helper: seed an epgp_config entry so create_post / update_post can resolve
// the EPGP channel without a real Discord lookup.
// ---------------------------------------------------------------------------
function setEpgpChannelConfig(channelId: string): void {
  const db = getDatabase();
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('epgp_rankings_channel_id', ?)").run(channelId);
}

// ---------------------------------------------------------------------------
// describe
// ---------------------------------------------------------------------------
describe('/epgp', () => {
  beforeEach(async () => {
    // discord: false — EPGP tests don't require Discord artifacts; faster.
    await resetAndSeed({ discord: false });
  });

  // =========================================================================
  // get_by_token
  // =========================================================================

  it('get_by_token (Zenith) — defers ephemeral then edits reply with css code block', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'epgp',
      subcommand: 'get_by_token',
      options: { tier_token: 'Zenith' },
    });

    await epgpCmd.execute(iact as unknown as ChatInputCommandInteraction);

    // Command calls deferReply then editReply.
    expect(iact.deferred).toBe(true);
    expect(iact.__deferred?.ephemeral).toBe(true);
    expect(iact.__editedReply).not.toBeNull();

    // The edited reply must contain css code blocks (header format).
    const content = replyContent(iact.__editedReply!);
    expect(content).toContain('```css');
    expect(content).toContain('[Name]');
    expect(content).toContain('[EP]');
    expect(content).toContain('[GP]');
    expect(content).toContain('[PR]');
  });

  it('get_by_token (Dreadful) — filtered display contains correct class types', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'epgp',
      subcommand: 'get_by_token',
      options: { tier_token: 'Dreadful' },
    });

    await epgpCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.deferred).toBe(true);
    expect(iact.__editedReply).not.toBeNull();

    // Dreadful = Death Knight, Demon Hunter, Warlock — the filter text should appear
    // in the header code block.
    const content = replyContent(iact.__editedReply!);
    expect(content).toContain('[Filtered by Dreadful token]');
  });

  it('get_by_token (Mystic) — filter header includes tier name', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'epgp',
      subcommand: 'get_by_token',
      options: { tier_token: 'Mystic' },
    });

    await epgpCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.__editedReply).not.toBeNull();
    const content = replyContent(iact.__editedReply!);
    expect(content).toContain('[Filtered by Mystic token]');
  });

  it('get_by_token (Venerated) — filter header includes tier name', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'epgp',
      subcommand: 'get_by_token',
      options: { tier_token: 'Venerated' },
    });

    await epgpCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.__editedReply).not.toBeNull();
    const content = replyContent(iact.__editedReply!);
    expect(content).toContain('[Filtered by Venerated token]');
  });

  // =========================================================================
  // get_by_armour
  // =========================================================================

  it('get_by_armour (Cloth) — defers ephemeral then edits reply with filtered css block', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'epgp',
      subcommand: 'get_by_armour',
      options: { armour_type: 'Cloth' },
    });

    await epgpCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.deferred).toBe(true);
    expect(iact.__deferred?.ephemeral).toBe(true);
    expect(iact.__editedReply).not.toBeNull();

    const content = replyContent(iact.__editedReply!);
    expect(content).toContain('```css');
    expect(content).toContain('[Filtered by Cloth]');
  });

  it('get_by_armour (Leather) — filter header includes armour type', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'epgp',
      subcommand: 'get_by_armour',
      options: { armour_type: 'Leather' },
    });

    await epgpCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.__editedReply).not.toBeNull();
    const content = replyContent(iact.__editedReply!);
    expect(content).toContain('[Filtered by Leather]');
  });

  it('get_by_armour (Mail) — filter header includes armour type', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'epgp',
      subcommand: 'get_by_armour',
      options: { armour_type: 'Mail' },
    });

    await epgpCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.__editedReply).not.toBeNull();
    const content = replyContent(iact.__editedReply!);
    expect(content).toContain('[Filtered by Mail]');
  });

  it('get_by_armour (Plate) — filter header includes armour type', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'epgp',
      subcommand: 'get_by_armour',
      options: { armour_type: 'Plate' },
    });

    await epgpCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.__editedReply).not.toBeNull();
    const content = replyContent(iact.__editedReply!);
    expect(content).toContain('[Filtered by Plate]');
  });

  // =========================================================================
  // Display content sanity — footer present in all display commands
  // =========================================================================

  it('get_by_token — reply includes [Last Upload:] and [Cutoff Date:] footer lines', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'epgp',
      subcommand: 'get_by_token',
      options: { tier_token: 'Zenith' },
    });

    await epgpCmd.execute(iact as unknown as ChatInputCommandInteraction);

    // When display fits in ≤2000 chars it goes into editReply; otherwise
    // footer goes into __followUps. Check both.
    const edited = replyContent(iact.__editedReply!);
    const allContent = [edited, ...iact.__followUps.map((f) => replyContent(f))].join('\n');

    expect(allContent).toContain('[Last Upload:');
    expect(allContent).toContain('[Cutoff Date:');
  });

  it('get_by_armour — reply includes [Last Upload:] and [Cutoff Date:] footer lines', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'epgp',
      subcommand: 'get_by_armour',
      options: { armour_type: 'Plate' },
    });

    await epgpCmd.execute(iact as unknown as ChatInputCommandInteraction);

    const edited = replyContent(iact.__editedReply!);
    const allContent = [edited, ...iact.__followUps.map((f) => replyContent(f))].join('\n');

    expect(allContent).toContain('[Last Upload:');
    expect(allContent).toContain('[Cutoff Date:');
  });

  // =========================================================================
  // create_post — needs epgp_rankings_channel_id configured
  // =========================================================================

  it('create_post — fails gracefully when no EPGP channel is configured', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    // Do NOT set epgp_rankings_channel_id — let it fail naturally.
    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'epgp',
      subcommand: 'create_post',
    });

    await epgpCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.deferred).toBe(true);
    expect(iact.__editedReply).not.toBeNull();
    // Should reply with failure message since channel not configured.
    const content = replyContent(iact.__editedReply!);
    expect(content).toContain('Failed');
  });

  it('create_post — succeeds when EPGP channel is configured, sends header/body/footer messages', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    // Configure the EPGP channel to be the sandbox system channel.
    setEpgpChannelConfig(channel.id);

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'epgp',
      subcommand: 'create_post',
    });

    await epgpCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.deferred).toBe(true);
    expect(iact.__editedReply).not.toBeNull();
    const content = replyContent(iact.__editedReply!);
    expect(content).toContain('Created EPGP display');

    // DB: epgp_config should now have header_message_id, body_message_ids, footer_message_id.
    const headerRow = queryOne<{ value: string }>('SELECT value FROM epgp_config WHERE key = ?', ['header_message_id']);
    expect(headerRow?.value).toBeDefined();
    const bodyRow = queryOne<{ value: string }>('SELECT value FROM epgp_config WHERE key = ?', ['body_message_ids']);
    expect(bodyRow?.value).toBeDefined();
    const footerRow = queryOne<{ value: string }>('SELECT value FROM epgp_config WHERE key = ?', ['footer_message_id']);
    expect(footerRow?.value).toBeDefined();
  });

  // =========================================================================
  // update_post — needs epgp_rankings_channel_id + existing post IDs
  // =========================================================================

  it('update_post — fails gracefully when no EPGP channel is configured', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    // No channel config.
    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'epgp',
      subcommand: 'update_post',
    });

    await epgpCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.deferred).toBe(true);
    expect(iact.__editedReply).not.toBeNull();
    const content = replyContent(iact.__editedReply!);
    expect(content).toContain('Failed');
  });

  it('update_post — succeeds when channel configured; falls back to create if no prior post IDs', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    // Configure the EPGP channel but do NOT seed epgp_config rows.
    // updateDisplayPost will detect missing IDs and call createDisplayPost instead.
    setEpgpChannelConfig(channel.id);

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'epgp',
      subcommand: 'update_post',
    });

    await epgpCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.deferred).toBe(true);
    expect(iact.__editedReply).not.toBeNull();
    const content = replyContent(iact.__editedReply!);
    expect(content).toContain('Updated EPGP display');
  });

  it('update_post — after create_post, update_post edits existing messages successfully', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    setEpgpChannelConfig(channel.id);

    // Step 1: create the display post.
    const createIact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'epgp',
      subcommand: 'create_post',
    });
    await epgpCmd.execute(createIact as unknown as ChatInputCommandInteraction);
    expect(replyContent(createIact.__editedReply!)).toContain('Created EPGP display');

    // Step 2: update the display post (should edit existing messages).
    const updateIact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'epgp',
      subcommand: 'update_post',
    });
    await epgpCmd.execute(updateIact as unknown as ChatInputCommandInteraction);

    expect(updateIact.deferred).toBe(true);
    expect(updateIact.__editedReply).not.toBeNull();
    const content = replyContent(updateIact.__editedReply!);
    expect(content).toContain('Updated EPGP display');
  });

  // =========================================================================
  // upload — DEFERRED: requires a real HTTP-accessible attachment URL.
  // The upload subcommand fetches the file via fetch(attachment.url) from Discord's
  // CDN. In the e2e harness there is no way to serve a local JSON file over HTTP
  // without spinning up a test server, and the fakeChatInput options shim passes
  // any object through getAttachment() as-is — so a { url: 'file://...' } shim
  // would cause fetch() to reject on Windows. Deferring until a test-server
  // fixture or mock-fetch infrastructure is added.
  // =========================================================================
});

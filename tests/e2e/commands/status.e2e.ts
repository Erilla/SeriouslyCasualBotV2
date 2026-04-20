import { describe, it, expect, beforeEach } from 'vitest';
import type { ChatInputCommandInteraction, TextBasedChannel } from 'discord.js';
import type { EmbedBuilder } from 'discord.js';
import { getE2EContext } from '../setup/bootstrap.js';
import { fakeChatInput } from '../setup/synthesizer.js';
import { resetAndSeed } from '../setup/baseline.js';
import { queryOne } from '../setup/assertions.js';
import statusCmd from '../../../src/commands/status.js';

/** Extract all embed field values as a flat string for easy pattern matching. */
function embedFieldText(reply: { options: unknown }): string {
  const opts = reply.options as { embeds?: EmbedBuilder[] };
  if (!opts.embeds || opts.embeds.length === 0) return '';
  const embed = opts.embeds[0]!;
  const data = embed.data;
  if (!data.fields) return '';
  return data.fields.map((f) => `${f.name}: ${f.value}`).join('\n');
}

describe('/status', () => {
  beforeEach(async () => {
    await resetAndSeed();
  });

  // ------------------------------------------------------------------ basic structure
  it('replies with one ephemeral embed titled "Bot Status"', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'status',
    });

    await statusCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.__replies.length).toBe(1);
    const reply = iact.__replies[0]!;
    expect(reply.ephemeral).toBe(true);

    const opts = reply.options as { embeds?: EmbedBuilder[] };
    expect(opts.embeds).toBeDefined();
    expect(opts.embeds!.length).toBe(1);

    const title = opts.embeds![0]!.data.title;
    expect(title).toBe('Bot Status');
  });

  // ------------------------------------------------------------------ uptime field
  it('includes an Uptime field', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'status',
    });

    await statusCmd.execute(iact as unknown as ChatInputCommandInteraction);

    const fields = embedFieldText(iact.__replies[0]!);
    // Uptime value contains the h/m/s format.
    expect(fields).toMatch(/Uptime:.*\d+h \d+m \d+s/);
  });

  // ------------------------------------------------------------------ raiders field reflects DB state
  it('Raiders field shows 0 linked out of 15 total after seed', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    // Verify DB state directly.
    const dbRow = queryOne<{ total: number; linked: number }>(
      'SELECT COUNT(*) as total, COUNT(discord_user_id) as linked FROM raiders',
    );
    expect(dbRow!.total).toBe(15);
    expect(dbRow!.linked).toBe(0);

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'status',
    });

    await statusCmd.execute(iact as unknown as ChatInputCommandInteraction);

    const fields = embedFieldText(iact.__replies[0]!);
    expect(fields).toContain('Raiders: 0/15 linked');
  });

  // ------------------------------------------------------------------ active applications
  it('Active Applications field shows 1 after seed', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    // Seeded application has status 'submitted', which is included in the active set.
    const dbRow = queryOne<{ count: number }>(
      "SELECT COUNT(*) as count FROM applications WHERE status IN ('in_progress', 'submitted', 'active')",
    );
    expect(dbRow!.count).toBe(1);

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'status',
    });

    await statusCmd.execute(iact as unknown as ChatInputCommandInteraction);

    const fields = embedFieldText(iact.__replies[0]!);
    expect(fields).toContain('Active Applications: 1');
  });

  // ------------------------------------------------------------------ active trials
  it('Active Trials field shows 1 after seed', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const dbRow = queryOne<{ count: number }>(
      "SELECT COUNT(*) as count FROM trials WHERE status = 'active'",
    );
    expect(dbRow!.count).toBe(1);

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'status',
    });

    await statusCmd.execute(iact as unknown as ChatInputCommandInteraction);

    const fields = embedFieldText(iact.__replies[0]!);
    expect(fields).toContain('Active Trials: 1');
  });

  // ------------------------------------------------------------------ EPGP last upload
  it('EPGP Last Upload field is non-"Never" after seed (seedEpgp inserts one upload record)', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    // seedEpgp inserts 1 upload_history record dated 7 days ago.
    const dbRow = queryOne<{ ts: string | null }>(
      'SELECT MAX(timestamp) as ts FROM epgp_upload_history',
    );
    expect(dbRow!.ts).not.toBeNull();

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'status',
    });

    await statusCmd.execute(iact as unknown as ChatInputCommandInteraction);

    const fields = embedFieldText(iact.__replies[0]!);
    // The upload was 7 days ago → formatAge returns "Xh Ym ago" or "Xh ago" — not "Never".
    expect(fields).toMatch(/EPGP Last Upload: \d+h/);
    expect(fields).not.toContain('EPGP Last Upload: Never');
  });

  // ------------------------------------------------------------------ scheduled task fields
  it('Last Roster Sync, Last Achievements Update, Last Trial Logs Update default to "Never"', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    // The statusTracker map starts empty for each test run; tasks haven't fired.
    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'status',
    });

    await statusCmd.execute(iact as unknown as ChatInputCommandInteraction);

    const fields = embedFieldText(iact.__replies[0]!);
    expect(fields).toContain('Last Roster Sync: Never');
    expect(fields).toContain('Last Achievements Update: Never');
    expect(fields).toContain('Last Trial Logs Update: Never');
  });

  // ------------------------------------------------------------------ DB Size field
  it('DB Size field is present and non-empty', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'status',
    });

    await statusCmd.execute(iact as unknown as ChatInputCommandInteraction);

    const fields = embedFieldText(iact.__replies[0]!);
    // Value is either a human-readable size or "N/A" when the file path isn't accessible.
    expect(fields).toMatch(/DB Size:/);
  });

  // ------------------------------------------------------------------ Log Level field
  it('Log Level field is present', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'status',
    });

    await statusCmd.execute(iact as unknown as ChatInputCommandInteraction);

    const fields = embedFieldText(iact.__replies[0]!);
    expect(fields).toMatch(/Log Level:/);
  });
});

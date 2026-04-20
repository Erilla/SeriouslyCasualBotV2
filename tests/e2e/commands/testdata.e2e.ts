import { describe, it, expect, beforeEach } from 'vitest';
import type { ChatInputCommandInteraction, TextBasedChannel } from 'discord.js';
import { getE2EContext } from '../setup/bootstrap.js';
import { fakeChatInput } from '../setup/synthesizer.js';
import { resetAndSeed } from '../setup/baseline.js';
import { queryOne, queryAll } from '../setup/assertions.js';
import { getDatabase } from '../../../src/database/db.js';
import testdataCmd from '../../../src/commands/testdata.js';

// ---------------------------------------------------------------------------
// Helper: extract reply content string from a FakeReply.
// ---------------------------------------------------------------------------
function replyContent(reply: { options: unknown }): string {
  const opts = reply.options;
  if (typeof opts === 'string') return opts;
  return (opts as { content?: string }).content ?? '';
}

// ---------------------------------------------------------------------------
// describe
// ---------------------------------------------------------------------------
describe('/testdata', () => {
  beforeEach(async () => {
    // discord:false keeps beforeEach fast. Individual tests that exercise
    // discord:true variants create artifacts mid-test; the next beforeEach's
    // /testdata reset still tears them down via #47's resetDiscordArtifacts.
    await resetAndSeed({ discord: false });
  });

  // =========================================================================
  // seed_raiders (DB only)
  // =========================================================================

  it('seed_raiders — defers ephemeral, inserts 15 mock raiders, replies with success', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    // Wipe EPGP data first (it references raiders via FK), then wipe raiders.
    const db = getDatabase();
    db.prepare('DELETE FROM epgp_loot_history').run();
    db.prepare('DELETE FROM epgp_effort_points').run();
    db.prepare('DELETE FROM epgp_gear_points').run();
    db.prepare('DELETE FROM epgp_upload_history').run();
    db.prepare('DELETE FROM raiders').run();

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'testdata',
      subcommand: 'seed_raiders',
    });

    await testdataCmd.execute(iact as unknown as ChatInputCommandInteraction);

    // Command defers then edits.
    expect(iact.deferred).toBe(true);
    expect(iact.__deferred?.ephemeral).toBe(true);
    expect(iact.__editedReply).not.toBeNull();

    const content = replyContent(iact.__editedReply!);
    expect(content).toMatch(/15 mock raiders/i);

    // DB: 15 raiders inserted.
    const row = queryOne<{ c: number }>('SELECT COUNT(*) as c FROM raiders');
    expect(row?.c).toBe(15);
  });

  // =========================================================================
  // seed_raiders discord:true
  // =========================================================================

  it('seed_raiders discord:true — defers ephemeral, DB has ≥1 raider, reply mentions raiders seeded', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    // Delete EPGP data first (FK child of raiders), then delete raiders.
    const db = getDatabase();
    db.prepare('DELETE FROM epgp_loot_history').run();
    db.prepare('DELETE FROM epgp_effort_points').run();
    db.prepare('DELETE FROM epgp_gear_points').run();
    db.prepare('DELETE FROM epgp_upload_history').run();
    db.prepare('DELETE FROM raiders').run();

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'testdata',
      subcommand: 'seed_raiders',
      options: { discord: true },
    });

    await testdataCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.deferred).toBe(true);
    expect(iact.__editedReply).not.toBeNull();

    const content = replyContent(iact.__editedReply!);
    // The discord path replies with "Seeded raiders: **N** total in DB."
    expect(content).toMatch(/Seeded raiders/i);

    // DB: raiders were seeded.
    const row = queryOne<{ c: number }>('SELECT COUNT(*) as c FROM raiders');
    expect(row?.c).toBeGreaterThan(0);
  });

  // =========================================================================
  // seed_application (DB only)
  // =========================================================================

  it('seed_application — defers ephemeral, inserts application + answers + votes, replies with ID', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const countBefore = queryOne<{ c: number }>('SELECT COUNT(*) as c FROM applications')?.c ?? 0;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'testdata',
      subcommand: 'seed_application',
    });

    await testdataCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.deferred).toBe(true);
    expect(iact.__deferred?.ephemeral).toBe(true);
    expect(iact.__editedReply).not.toBeNull();

    const content = replyContent(iact.__editedReply!);
    // "Seeded 1 mock application (ID: N) with X answers and Y votes."
    expect(content).toMatch(/Seeded 1 mock application/i);
    expect(content).toContain('answers');
    expect(content).toContain('votes');

    // DB: one more application than before.
    const countAfter = queryOne<{ c: number }>('SELECT COUNT(*) as c FROM applications')?.c ?? 0;
    expect(countAfter).toBe(countBefore + 1);

    // DB: application_answers exist.
    const answers = queryOne<{ c: number }>('SELECT COUNT(*) as c FROM application_answers');
    expect(answers?.c).toBeGreaterThan(0);
  });

  // =========================================================================
  // seed_application discord:true
  // =========================================================================

  it('seed_application discord:true — defers ephemeral, DB has extra application row, reply mentions seeded', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const countBefore = queryOne<{ c: number }>('SELECT COUNT(*) as c FROM applications')?.c ?? 0;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'testdata',
      subcommand: 'seed_application',
      options: { discord: true },
    });

    await testdataCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.deferred).toBe(true);
    expect(iact.__editedReply).not.toBeNull();

    const content = replyContent(iact.__editedReply!);
    // Discord path: "Seeded application **#N**."
    expect(content).toMatch(/Seeded application/i);

    const countAfter = queryOne<{ c: number }>('SELECT COUNT(*) as c FROM applications')?.c ?? 0;
    expect(countAfter).toBe(countBefore + 1);
  });

  // =========================================================================
  // seed_application_variety
  // =========================================================================

  it('seed_application_variety — defers ephemeral, inserts 5 applications covering all statuses', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const countBefore = queryOne<{ c: number }>('SELECT COUNT(*) as c FROM applications')?.c ?? 0;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'testdata',
      subcommand: 'seed_application_variety',
    });

    await testdataCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.deferred).toBe(true);
    expect(iact.__deferred?.ephemeral).toBe(true);
    expect(iact.__editedReply).not.toBeNull();

    const content = replyContent(iact.__editedReply!);
    // "Seeded 5 applications (in_progress: 1, submitted: 1, ...)."
    expect(content).toMatch(/Seeded 5 applications/i);
    expect(content).toContain('submitted');
    expect(content).toContain('accepted');
    expect(content).toContain('rejected');

    // DB: exactly 5 new applications.
    const countAfter = queryOne<{ c: number }>('SELECT COUNT(*) as c FROM applications')?.c ?? 0;
    expect(countAfter).toBe(countBefore + 5);
  });

  // =========================================================================
  // seed_trial (DB only)
  // =========================================================================

  it('seed_trial — defers ephemeral, inserts 1 trial + 3 alerts, reply contains trial ID', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const trialsBefore = queryOne<{ c: number }>('SELECT COUNT(*) as c FROM trials')?.c ?? 0;
    const alertsBefore = queryOne<{ c: number }>('SELECT COUNT(*) as c FROM trial_alerts')?.c ?? 0;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'testdata',
      subcommand: 'seed_trial',
    });

    await testdataCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.deferred).toBe(true);
    expect(iact.__deferred?.ephemeral).toBe(true);
    expect(iact.__editedReply).not.toBeNull();

    const content = replyContent(iact.__editedReply!);
    // "Seeded 1 mock trial (ID: N) with 3 trial alerts."
    expect(content).toMatch(/Seeded 1 mock trial/i);
    expect(content).toContain('3 trial alerts');

    // DB: one new trial, three new alerts.
    const trialsAfter = queryOne<{ c: number }>('SELECT COUNT(*) as c FROM trials')?.c ?? 0;
    expect(trialsAfter).toBe(trialsBefore + 1);

    const alertsAfter = queryOne<{ c: number }>('SELECT COUNT(*) as c FROM trial_alerts')?.c ?? 0;
    expect(alertsAfter).toBe(alertsBefore + 3);
  });

  // =========================================================================
  // seed_trial discord:true
  // =========================================================================

  it('seed_trial discord:true — defers ephemeral, DB gains ≥0 trial rows, no error reply', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const trialsBefore = queryOne<{ c: number }>('SELECT COUNT(*) as c FROM trials')?.c ?? 0;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'testdata',
      subcommand: 'seed_trial',
      options: { discord: true },
    });

    await testdataCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.deferred).toBe(true);
    expect(iact.__editedReply).not.toBeNull();

    const content = replyContent(iact.__editedReply!);
    // Either "Seeded trial **#N** ..." or a skipped variant — never a command error.
    expect(content).not.toMatch(/Failed to run/i);

    const trialsAfter = queryOne<{ c: number }>('SELECT COUNT(*) as c FROM trials')?.c ?? 0;
    // At least as many trials as before (never fewer due to this command).
    expect(trialsAfter).toBeGreaterThanOrEqual(trialsBefore);
  });

  // =========================================================================
  // seed_epgp
  // =========================================================================

  it('seed_epgp — defers ephemeral, inserts effort/gear/loot/upload records, reply lists counts', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'testdata',
      subcommand: 'seed_epgp',
    });

    await testdataCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.deferred).toBe(true);
    expect(iact.__deferred?.ephemeral).toBe(true);
    expect(iact.__editedReply).not.toBeNull();

    const content = replyContent(iact.__editedReply!);
    // "Seeded EPGP data for **N** raiders:\n• X effort point entries..."
    expect(content).toMatch(/Seeded EPGP data/i);
    expect(content).toContain('effort point');
    expect(content).toContain('gear point');
    expect(content).toContain('loot history');
    expect(content).toContain('upload history');

    // DB: at least 1 EP entry.
    const ep = queryOne<{ c: number }>('SELECT COUNT(*) as c FROM epgp_effort_points');
    expect(ep?.c).toBeGreaterThan(0);

    // DB: upload history record present.
    const upload = queryOne<{ c: number }>('SELECT COUNT(*) as c FROM epgp_upload_history');
    expect(upload?.c).toBeGreaterThan(0);
  });

  // =========================================================================
  // seed_loot (DB only)
  // =========================================================================

  it('seed_loot — defers ephemeral, inserts 3 loot posts (boss IDs 99901–99903), reply confirms count', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    // Wipe loot_posts first (seed_all already put them there via resetAndSeed).
    getDatabase().prepare('DELETE FROM loot_posts').run();

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'testdata',
      subcommand: 'seed_loot',
    });

    await testdataCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.deferred).toBe(true);
    expect(iact.__deferred?.ephemeral).toBe(true);
    expect(iact.__editedReply).not.toBeNull();

    const content = replyContent(iact.__editedReply!);
    // "Seeded 3 mock loot posts (boss IDs 99901-99903)."
    expect(content).toMatch(/Seeded 3 mock loot posts/i);
    expect(content).toContain('99901');

    // DB: 3 loot_posts for the mock boss IDs.
    const rows = queryAll<{ boss_id: number }>('SELECT boss_id FROM loot_posts WHERE boss_id IN (99901, 99902, 99903)');
    expect(rows.length).toBe(3);
  });

  // =========================================================================
  // seed_loot discord:true
  // =========================================================================

  it('seed_loot discord:true — defers ephemeral, reply reports DB count, no command error', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    // Wipe so the OR IGNORE seed can insert.
    getDatabase().prepare('DELETE FROM loot_posts').run();

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'testdata',
      subcommand: 'seed_loot',
      options: { discord: true },
    });

    await testdataCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.deferred).toBe(true);
    expect(iact.__editedReply).not.toBeNull();

    const content = replyContent(iact.__editedReply!);
    // Discord path: "DB loot_posts inserted: **N**." (may be skipped if no channel configured).
    expect(content).not.toMatch(/Failed to run/i);
    expect(content).toMatch(/DB loot_posts inserted/i);
  });

  // =========================================================================
  // seed_all (DB only)
  // =========================================================================

  it('seed_all — defers ephemeral, seeds all tables, reply lists all categories', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    // Wipe everything so seed_all has a clean slate.
    const db = getDatabase();
    db.prepare('DELETE FROM trial_alerts').run();
    db.prepare('DELETE FROM trials').run();
    db.prepare('DELETE FROM application_answers').run();
    db.prepare('DELETE FROM application_votes').run();
    db.prepare('DELETE FROM applications').run();
    db.prepare('DELETE FROM loot_posts').run();
    db.prepare('DELETE FROM epgp_loot_history').run();
    db.prepare('DELETE FROM epgp_effort_points').run();
    db.prepare('DELETE FROM epgp_gear_points').run();
    db.prepare('DELETE FROM epgp_upload_history').run();
    db.prepare('DELETE FROM raiders').run();

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'testdata',
      subcommand: 'seed_all',
    });

    await testdataCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.deferred).toBe(true);
    expect(iact.__deferred?.ephemeral).toBe(true);
    expect(iact.__editedReply).not.toBeNull();

    const content = replyContent(iact.__editedReply!);
    // "**seed_all** (DB only):\n• Raiders in DB: **15**\n• Application: **#N**\n..."
    expect(content).toMatch(/seed_all/i);
    expect(content).toContain('Raiders in DB');
    expect(content).toContain('Application');
    expect(content).toContain('Trial');
    expect(content).toContain('Loot posts in DB');

    // DB sanity: raiders present.
    const raiders = queryOne<{ c: number }>('SELECT COUNT(*) as c FROM raiders');
    expect(raiders?.c).toBeGreaterThan(0);

    // DB sanity: at least one application.
    const apps = queryOne<{ c: number }>('SELECT COUNT(*) as c FROM applications');
    expect(apps?.c).toBeGreaterThan(0);
  });

  // =========================================================================
  // seed_all discord:true
  // =========================================================================

  it('seed_all discord:true — defers ephemeral, DB populated, reply reports discord mode', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const db = getDatabase();
    db.prepare('DELETE FROM trial_alerts').run();
    db.prepare('DELETE FROM trials').run();
    db.prepare('DELETE FROM application_answers').run();
    db.prepare('DELETE FROM application_votes').run();
    db.prepare('DELETE FROM applications').run();
    db.prepare('DELETE FROM loot_posts').run();
    db.prepare('DELETE FROM epgp_loot_history').run();
    db.prepare('DELETE FROM epgp_effort_points').run();
    db.prepare('DELETE FROM epgp_gear_points').run();
    db.prepare('DELETE FROM epgp_upload_history').run();
    db.prepare('DELETE FROM raiders').run();

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'testdata',
      subcommand: 'seed_all',
      options: { discord: true },
    });

    await testdataCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.deferred).toBe(true);
    expect(iact.__editedReply).not.toBeNull();

    const content = replyContent(iact.__editedReply!);
    expect(content).not.toMatch(/Failed to run/i);
    // Discord mode header includes "with Discord".
    expect(content).toMatch(/with Discord/i);

    // DB: raiders seeded.
    const raiders = queryOne<{ c: number }>('SELECT COUNT(*) as c FROM raiders');
    expect(raiders?.c).toBeGreaterThan(0);
  });

  // =========================================================================
  // reset confirm:true
  // =========================================================================

  it('reset confirm:true — defers ephemeral, wipes all data tables, re-seeds defaults, reply confirms wipe', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    // Verify data exists before reset.
    const raidersBefore = queryOne<{ c: number }>('SELECT COUNT(*) as c FROM raiders')?.c ?? 0;
    expect(raidersBefore).toBeGreaterThan(0);

    // The seedLoot baseline puts mock loot_posts with fake channel IDs (not real
    // Discord snowflakes). resetData calls resetDiscordArtifacts which tries to
    // fetch those channels — the Discord API rejects non-snowflake IDs with a
    // form error (not a 404), causing the reset to abort.
    // Delete these rows pre-flight so resetDiscordArtifacts finds 0 artifacts.
    getDatabase().prepare('DELETE FROM loot_posts').run();

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'testdata',
      subcommand: 'reset',
      options: { confirm: true },
    });

    await testdataCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.deferred).toBe(true);
    expect(iact.__deferred?.ephemeral).toBe(true);
    expect(iact.__editedReply).not.toBeNull();

    const content = replyContent(iact.__editedReply!);
    // "All data wiped and defaults (including application questions) re-seeded."
    expect(content).toMatch(/All data wiped/i);
    expect(content).toMatch(/re-seeded/i);

    // DB: raiders table wiped.
    const raidersAfter = queryOne<{ c: number }>('SELECT COUNT(*) as c FROM raiders')?.c ?? 0;
    expect(raidersAfter).toBe(0);

    // DB: applications table wiped.
    const appsAfter = queryOne<{ c: number }>('SELECT COUNT(*) as c FROM applications')?.c ?? 0;
    expect(appsAfter).toBe(0);

    // DB: default application questions re-seeded.
    const questions = queryOne<{ c: number }>('SELECT COUNT(*) as c FROM application_questions');
    expect(questions?.c).toBeGreaterThan(0);
  });

  // =========================================================================
  // reset confirm:false
  // =========================================================================

  it('reset confirm:false — defers ephemeral, refuses to wipe, data remains, reply asks for confirm:true', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const raidersBefore = queryOne<{ c: number }>('SELECT COUNT(*) as c FROM raiders')?.c ?? 0;
    expect(raidersBefore).toBeGreaterThan(0);

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'testdata',
      subcommand: 'reset',
      options: { confirm: false },
    });

    await testdataCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.deferred).toBe(true);
    expect(iact.__deferred?.ephemeral).toBe(true);
    expect(iact.__editedReply).not.toBeNull();

    const content = replyContent(iact.__editedReply!);
    // "Pass `confirm:true` to actually wipe data."
    expect(content).toContain('confirm:true');

    // DB: raiders table must NOT have been wiped.
    const raidersAfter = queryOne<{ c: number }>('SELECT COUNT(*) as c FROM raiders')?.c ?? 0;
    expect(raidersAfter).toBe(raidersBefore);
  });
});

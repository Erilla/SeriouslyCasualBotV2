import { describe, it, expect, beforeEach } from 'vitest';
import type { ChatInputCommandInteraction, TextBasedChannel } from 'discord.js';
import { getE2EContext } from '../setup/bootstrap.js';
import { fakeChatInput } from '../setup/synthesizer.js';
import { resetAndSeed } from '../setup/baseline.js';
import { queryOne, queryAll } from '../setup/assertions.js';
import settingsCmd from '../../../src/commands/settings.js';

// Helper: extract reply content string from a FakeReply.
function replyContent(reply: { options: unknown }): string {
  const opts = reply.options;
  if (typeof opts === 'string') return opts;
  return (opts as { content?: string }).content ?? '';
}

describe('/settings', () => {
  beforeEach(async () => {
    await resetAndSeed();
  });

  // ------------------------------------------------------------------ get_setting
  it('get_setting — replies ephemeral with the current value of a disabled setting', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'settings',
      subcommand: 'get_setting',
      options: { setting_name: 'alertSignup_Wednesday' },
    });

    await settingsCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.__replies.length).toBe(1);
    const reply = iact.__replies[0]!;
    expect(reply.ephemeral).toBe(true);
    const content = replyContent(reply);
    expect(content).toContain('alertSignup_Wednesday');
    expect(content).toContain('disabled');
  });

  // ------------------------------------------------------------------ toggle_setting (off → on)
  it('toggle_setting — toggles a disabled setting to enabled and persists to DB', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    // Pre-condition: seeded value is 0 (disabled).
    const before = queryOne<{ value: number }>(
      'SELECT value FROM settings WHERE key = ?',
      ['alertSignup_Sunday'],
    );
    expect(before?.value).toBe(0);

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'settings',
      subcommand: 'toggle_setting',
      options: { setting_name: 'alertSignup_Sunday' },
    });

    await settingsCmd.execute(iact as unknown as ChatInputCommandInteraction);

    // Reply assertions.
    expect(iact.__replies.length).toBe(1);
    const reply = iact.__replies[0]!;
    expect(reply.ephemeral).toBe(true);
    const content = replyContent(reply);
    expect(content).toContain('alertSignup_Sunday');
    expect(content).toContain('enabled');

    // DB persistence: value must now be 1.
    const after = queryOne<{ value: number }>(
      'SELECT value FROM settings WHERE key = ?',
      ['alertSignup_Sunday'],
    );
    expect(after?.value).toBe(1);
  });

  // ------------------------------------------------------------------ toggle_setting (on → off)
  it('toggle_setting — toggles an enabled setting back to disabled and persists to DB', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    // First toggle: disabled → enabled.
    const firstToggle = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'settings',
      subcommand: 'toggle_setting',
      options: { setting_name: 'alertSignup_Wednesday_48' },
    });
    await settingsCmd.execute(firstToggle as unknown as ChatInputCommandInteraction);

    const mid = queryOne<{ value: number }>(
      'SELECT value FROM settings WHERE key = ?',
      ['alertSignup_Wednesday_48'],
    );
    expect(mid?.value).toBe(1);

    // Second toggle: enabled → disabled.
    const secondToggle = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'settings',
      subcommand: 'toggle_setting',
      options: { setting_name: 'alertSignup_Wednesday_48' },
    });
    await settingsCmd.execute(secondToggle as unknown as ChatInputCommandInteraction);

    const content = replyContent(secondToggle.__replies[0]!);
    expect(content).toContain('alertSignup_Wednesday_48');
    expect(content).toContain('disabled');

    const after = queryOne<{ value: number }>(
      'SELECT value FROM settings WHERE key = ?',
      ['alertSignup_Wednesday_48'],
    );
    expect(after?.value).toBe(0);
  });

  // ------------------------------------------------------------------ get_all_settings
  it('get_all_settings — replies ephemeral listing all four settings', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'settings',
      subcommand: 'get_all_settings',
    });

    await settingsCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.__replies.length).toBe(1);
    const reply = iact.__replies[0]!;
    expect(reply.ephemeral).toBe(true);
    const content = replyContent(reply);
    expect(content).toMatch(/All Settings/i);

    // All four seeded keys should appear.
    expect(content).toContain('alertSignup_Wednesday');
    expect(content).toContain('alertSignup_Wednesday_48');
    expect(content).toContain('alertSignup_Sunday');
    expect(content).toContain('alertSignup_Sunday_48');

    // Verify DB has all four rows.
    const rows = queryAll<{ key: string; value: number }>('SELECT key, value FROM settings ORDER BY key');
    expect(rows.length).toBe(4);
  });

  // ------------------------------------------------------------------ get_all_settings after a toggle
  it('get_all_settings — reflects a prior toggle in its output', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    // Toggle Sunday_48 on first.
    const toggleIact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'settings',
      subcommand: 'toggle_setting',
      options: { setting_name: 'alertSignup_Sunday_48' },
    });
    await settingsCmd.execute(toggleIact as unknown as ChatInputCommandInteraction);

    // Now get_all_settings should show Sunday_48 as enabled.
    const getAllIact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'settings',
      subcommand: 'get_all_settings',
    });
    await settingsCmd.execute(getAllIact as unknown as ChatInputCommandInteraction);

    const content = replyContent(getAllIact.__replies[0]!);
    // alertSignup_Sunday_48 line must say "enabled".
    expect(content).toMatch(/alertSignup_Sunday_48.*enabled/);
  });

  // ------------------------------------------------------------------ get_setting for Sunday 48h key
  it('get_setting — reports Sunday_48 as disabled initially', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;

    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.officer,
      user: ctx.officer.user,
      commandName: 'settings',
      subcommand: 'get_setting',
      options: { setting_name: 'alertSignup_Sunday_48' },
    });

    await settingsCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.__replies.length).toBe(1);
    const content = replyContent(iact.__replies[0]!);
    expect(content).toContain('alertSignup_Sunday_48');
    expect(content).toContain('disabled');
    expect(iact.__replies[0]!.ephemeral).toBe(true);
  });
});

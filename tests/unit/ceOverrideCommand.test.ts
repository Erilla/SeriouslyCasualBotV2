import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatInputCommandInteraction } from 'discord.js';

const mocks = vi.hoisted(() => ({
  requireOfficer: vi.fn(),
  audit: vi.fn(),
  parseCeCutoffDate: vi.fn(),
  setCeOverride: vi.fn(),
  removeCeOverride: vi.fn(),
  updateAchievements: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock('../../src/utils.js', () => ({
  requireOfficer: mocks.requireOfficer,
  audit: mocks.audit,
}));

vi.mock('../../src/functions/guild-info/ceOverrides.js', () => ({
  parseCeCutoffDate: mocks.parseCeCutoffDate,
  setCeOverride: mocks.setCeOverride,
  removeCeOverride: mocks.removeCeOverride,
}));

vi.mock('../../src/functions/guild-info/updateAchievements.js', () => ({
  updateAchievements: mocks.updateAchievements,
}));

vi.mock('../../src/services/logger.js', () => ({
  logger: { error: mocks.loggerError },
}));

import command from '../../src/commands/ceoverride.js';

function fakeInteraction(values: { subcommand: 'set' | 'remove'; raid: string; cutoff?: string }) {
  return {
    options: {
      getSubcommand: vi.fn().mockReturnValue(values.subcommand),
      getString: vi.fn((name: string) => (name === 'raid' ? values.raid : values.cutoff ?? null)),
    },
    reply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    client: {},
    user: {},
  };
}

describe('/ceoverride', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireOfficer.mockResolvedValue(true);
    mocks.updateAchievements.mockResolvedValue(undefined);
  });

  it('sets the normalized cutoff, audits it, and refreshes achievements', async () => {
    mocks.parseCeCutoffDate.mockReturnValue('2026-01-21T00:00:00.000Z');
    const interaction = fakeInteraction({
      subcommand: 'set',
      raid: 'manaforge-omega',
      cutoff: '2026-01-21',
    });

    await command.execute(interaction as unknown as ChatInputCommandInteraction);

    expect(mocks.setCeOverride).toHaveBeenCalledWith(
      'manaforge-omega',
      '2026-01-21T00:00:00.000Z',
    );
    expect(mocks.updateAchievements).toHaveBeenCalledWith(interaction.client);
    expect(mocks.audit).toHaveBeenCalledWith(
      interaction.user,
      'set CE override',
      'manaforge-omega: 2026-01-21',
    );
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringMatching(/saved.*updated/i) }),
    );
  });

  it('rejects an invalid cutoff before changing data or refreshing', async () => {
    mocks.parseCeCutoffDate.mockReturnValue(null);
    const interaction = fakeInteraction({
      subcommand: 'set',
      raid: 'manaforge-omega',
      cutoff: '21/01/2026',
    });

    await command.execute(interaction as unknown as ChatInputCommandInteraction);

    expect(mocks.setCeOverride).not.toHaveBeenCalled();
    expect(mocks.updateAchievements).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringMatching(/YYYY-MM-DD/) }),
    );
  });

  it('keeps the saved override and says refresh failed when image generation rejects', async () => {
    const failure = new Error('raider.io down');
    mocks.parseCeCutoffDate.mockReturnValue('2026-01-21T00:00:00.000Z');
    mocks.updateAchievements.mockRejectedValue(failure);
    const interaction = fakeInteraction({
      subcommand: 'set',
      raid: 'manaforge-omega',
      cutoff: '2026-01-21',
    });

    await command.execute(interaction as unknown as ChatInputCommandInteraction);

    expect(mocks.setCeOverride).toHaveBeenCalled();
    expect(mocks.loggerError).toHaveBeenCalledWith(
      'guild-info',
      'Achievements refresh failed after saving CE override: Error: raider.io down',
      failure,
    );
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringMatching(/saved.*refresh failed/i) }),
    );
  });

  it('does not refresh or audit when remove finds no override', async () => {
    mocks.removeCeOverride.mockReturnValue(false);
    const interaction = fakeInteraction({ subcommand: 'remove', raid: 'manaforge-omega' });

    await command.execute(interaction as unknown as ChatInputCommandInteraction);

    expect(mocks.updateAchievements).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringMatching(/No CE override/) }),
    );
  });
});

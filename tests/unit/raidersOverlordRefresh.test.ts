import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js';

const mocks = vi.hoisted(() => ({
  requireOfficer: vi.fn(),
  audit: vi.fn(),
  addOverlord: vi.fn(),
  removeOverlord: vi.fn(),
  getOverlords: vi.fn(),
  updateRecruitment: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock('../../src/database/db.js', () => ({ getDatabase: vi.fn(() => ({})) }));
vi.mock('../../src/utils.js', () => ({
  requireOfficer: mocks.requireOfficer,
  audit: mocks.audit,
}));
vi.mock('../../src/functions/raids/overlords.js', () => ({
  addOverlord: mocks.addOverlord,
  removeOverlord: mocks.removeOverlord,
  getOverlords: mocks.getOverlords,
}));
vi.mock('../../src/functions/guild-info/updateRecruitment.js', () => ({
  updateRecruitment: mocks.updateRecruitment,
}));
vi.mock('../../src/services/logger.js', () => ({
  logger: { error: mocks.loggerError },
}));

import command from '../../src/commands/raiders.js';

function interactionFor(subcommand: 'add_overlord' | 'remove_overlord') {
  const user = subcommand === 'add_overlord' ? { id: '123', toString: () => '<@123>' } : undefined;
  return {
    options: {
      getSubcommand: vi.fn(() => subcommand),
      getString: vi.fn(() => (subcommand === 'add_overlord' ? 'New Officer' : 'Old Officer')),
      getUser: vi.fn(() => user),
    },
    client: { id: 'client' },
    user: { id: 'officer' },
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

describe('/raiders Overlord Recruitment refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireOfficer.mockResolvedValue(true);
    mocks.addOverlord.mockReturnValue(undefined);
    mocks.removeOverlord.mockReturnValue(undefined);
    mocks.getOverlords.mockReturnValue([{ name: 'Old Officer', user_id: '456' }]);
    mocks.updateRecruitment.mockResolvedValue(undefined);
    mocks.audit.mockResolvedValue(undefined);
  });

  it('refreshes Recruitment after adding an Overlord', async () => {
    const interaction = interactionFor('add_overlord');

    await command.execute(interaction as unknown as ChatInputCommandInteraction);

    expect(mocks.addOverlord).toHaveBeenCalledWith('New Officer', '123');
    expect(mocks.updateRecruitment).toHaveBeenCalledWith(interaction.client);
    expect(mocks.updateRecruitment).toHaveBeenCalledOnce();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringMatching(/Added overlord/i) }),
    );
  });

  it('refreshes Recruitment after removing an Overlord', async () => {
    const interaction = interactionFor('remove_overlord');

    await command.execute(interaction as unknown as ChatInputCommandInteraction);

    expect(mocks.removeOverlord).toHaveBeenCalledWith('Old Officer');
    expect(mocks.updateRecruitment).toHaveBeenCalledWith(interaction.client);
    expect(mocks.updateRecruitment).toHaveBeenCalledOnce();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringMatching(/Removed overlord/i) }),
    );
  });

  it.each([
    ['add_overlord', 'added overlord', 'New Officer (<@123>)'],
    ['remove_overlord', 'removed overlord', 'Old Officer (<@456>)'],
  ] as const)(
    'keeps a saved %s change and reports a refresh failure',
    async (subcommand, action, detail) => {
      mocks.updateRecruitment.mockRejectedValue(new Error('guild-info unavailable'));
      const interaction = interactionFor(subcommand);

      await command.execute(interaction as unknown as ChatInputCommandInteraction);

      expect(mocks.audit).toHaveBeenCalledWith(interaction.user, action, detail);
      expect(mocks.loggerError).toHaveBeenCalledWith(
        'guild-info',
        expect.stringContaining('guild-info unavailable'),
        expect.any(Error),
      );
      expect(interaction.reply).toHaveBeenCalledWith({
        content: expect.stringMatching(/(Added|Removed).*Recruitment.*not refreshed.*\/guildinfo/i),
        flags: MessageFlags.Ephemeral,
      });
    },
  );

  it.each(['add_overlord', 'remove_overlord'] as const)(
    'does not refresh Recruitment when %s mutation fails',
    async (subcommand) => {
      const mutation = subcommand === 'add_overlord' ? mocks.addOverlord : mocks.removeOverlord;
      mutation.mockImplementationOnce(() => {
        throw new Error('database unavailable');
      });
      const interaction = interactionFor(subcommand);

      await command.execute(interaction as unknown as ChatInputCommandInteraction);

      expect(mocks.updateRecruitment).not.toHaveBeenCalled();
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringMatching(/Failed to (add|remove) overlord/i),
        }),
      );
    },
  );
});

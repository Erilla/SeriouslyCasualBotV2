import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatInputCommandInteraction } from 'discord.js';

const mocks = vi.hoisted(() => ({
  updateAchievements: vi.fn(),
  requireOfficer: vi.fn(),
  audit: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock('../../src/functions/guild-info/updateAchievements.js', () => ({
  updateAchievements: mocks.updateAchievements,
}));

vi.mock('../../src/utils.js', () => ({
  requireOfficer: mocks.requireOfficer,
  audit: mocks.audit,
}));

vi.mock('../../src/services/logger.js', () => ({
  logger: { error: mocks.loggerError },
}));

import updateAchievementsCommand from '../../src/commands/updateachievements.js';

describe('/updateachievements', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireOfficer.mockResolvedValue(true);
  });

  it('logs the update error before returning an ephemeral failure reply', async () => {
    const failure = new Error('raiderio API error: 400 Bad Request');
    mocks.updateAchievements.mockRejectedValue(failure);
    const interaction = {
      options: { getBoolean: vi.fn().mockReturnValue(false) },
      reply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      client: {},
      user: {},
    };

    await updateAchievementsCommand.execute(interaction as unknown as ChatInputCommandInteraction);

    expect(mocks.loggerError).toHaveBeenCalledWith(
      'guild-info',
      'Achievements update failed: Error: raiderio API error: 400 Bad Request',
      failure,
    );
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: 'Achievements update failed: Error: raiderio API error: 400 Bad Request',
    });
    expect(mocks.loggerError.mock.invocationCallOrder[0]).toBeLessThan(
      interaction.editReply.mock.invocationCallOrder[0]!,
    );
  });
});

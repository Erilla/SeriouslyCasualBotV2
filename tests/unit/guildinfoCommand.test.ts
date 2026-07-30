import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatInputCommandInteraction } from 'discord.js';

const mocks = vi.hoisted(() => ({
  requireOfficer: vi.fn(),
  audit: vi.fn(),
  clearGuildInfo: vi.fn(),
  updateAboutUs: vi.fn(),
  updateSchedule: vi.fn(),
  updateRecruitment: vi.fn(),
  updateAchievements: vi.fn(),
}));

vi.mock('../../src/utils.js', () => ({
  requireOfficer: mocks.requireOfficer,
  audit: mocks.audit,
}));

vi.mock('../../src/functions/guild-info/clearGuildInfo.js', () => ({
  clearGuildInfo: mocks.clearGuildInfo,
}));

vi.mock('../../src/functions/guild-info/updateAboutUs.js', () => ({
  updateAboutUs: mocks.updateAboutUs,
}));

vi.mock('../../src/functions/guild-info/updateSchedule.js', () => ({
  updateSchedule: mocks.updateSchedule,
}));

vi.mock('../../src/functions/guild-info/updateRecruitment.js', () => ({
  updateRecruitment: mocks.updateRecruitment,
}));

vi.mock('../../src/functions/guild-info/updateAchievements.js', () => ({
  updateAchievements: mocks.updateAchievements,
}));

import command from '../../src/commands/guildinfo.js';

function fakeInteraction(force: boolean | null) {
  return {
    options: { getBoolean: vi.fn().mockReturnValue(force) },
    reply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    client: {},
    user: {},
  };
}

describe('/guildinfo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireOfficer.mockResolvedValue(true);
    mocks.clearGuildInfo.mockResolvedValue(undefined);
    mocks.updateAboutUs.mockResolvedValue(undefined);
    mocks.updateSchedule.mockResolvedValue(undefined);
    mocks.updateRecruitment.mockResolvedValue(undefined);
    mocks.updateAchievements.mockResolvedValue(undefined);
  });

  it('normally refreshes all renderers without clearing their tracked messages', async () => {
    const interaction = fakeInteraction(null);

    await command.execute(interaction as unknown as ChatInputCommandInteraction);

    expect(mocks.clearGuildInfo).not.toHaveBeenCalled();
    expect(mocks.updateAboutUs).toHaveBeenCalledWith(interaction.client);
    expect(mocks.updateSchedule).toHaveBeenCalledWith(interaction.client);
    expect(mocks.updateRecruitment).toHaveBeenCalledWith(interaction.client);
    expect(mocks.updateAchievements).toHaveBeenCalledWith(interaction.client);
    expect(mocks.audit).toHaveBeenCalledWith(
      interaction.user,
      'refreshed guild info',
      'all embeds',
    );
  });

  it('clears managed messages before rendering when force:true is supplied', async () => {
    const interaction = fakeInteraction(true);

    await command.execute(interaction as unknown as ChatInputCommandInteraction);

    expect(mocks.clearGuildInfo).toHaveBeenCalledWith(interaction.client);
    expect(mocks.clearGuildInfo.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.updateAboutUs.mock.invocationCallOrder[0]!,
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      interaction.user,
      'refreshed guild info',
      'all embeds (force rebuild)',
    );
  });

  it('exposes force as an optional boolean command option', () => {
    const option = command.data.toJSON().options?.find((candidate) => candidate.name === 'force');

    expect(option).toMatchObject({
      name: 'force',
      description: 'Delete and recreate the four managed Guild Info messages',
      required: false,
      type: 5,
    });
  });
});

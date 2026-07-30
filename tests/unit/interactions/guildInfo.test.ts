import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GuildMember, MessageFlags, type ModalSubmitInteraction } from 'discord.js';

const mocks = vi.hoisted(() => ({
  saveAboutUs: vi.fn(),
  saveRecruitmentSection: vi.fn(),
  saveScheduleConfig: vi.fn(),
  saveScheduleDay: vi.fn(),
  saveGuildInfoLink: vi.fn(),
  saveAchievementsTitle: vi.fn(),
  validateGuildInfoUrl: vi.fn((url: string) => url),
  updateAboutUs: vi.fn(),
  updateSchedule: vi.fn(),
  updateRecruitment: vi.fn(),
  updateAchievements: vi.fn(),
  audit: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock('../../../src/config.js', () => ({ config: { officerRoleId: 'OFFICER' } }));
vi.mock('../../../src/functions/guild-info/editableGuildInfo.js', () => ({
  saveAboutUs: mocks.saveAboutUs,
  saveRecruitmentSection: mocks.saveRecruitmentSection,
  saveScheduleConfig: mocks.saveScheduleConfig,
  saveScheduleDay: mocks.saveScheduleDay,
  saveGuildInfoLink: mocks.saveGuildInfoLink,
  saveAchievementsTitle: mocks.saveAchievementsTitle,
  validateGuildInfoUrl: mocks.validateGuildInfoUrl,
}));
vi.mock('../../../src/functions/guild-info/updateAboutUs.js', () => ({
  updateAboutUs: mocks.updateAboutUs,
}));
vi.mock('../../../src/functions/guild-info/updateSchedule.js', () => ({
  updateSchedule: mocks.updateSchedule,
}));
vi.mock('../../../src/functions/guild-info/updateRecruitment.js', () => ({
  updateRecruitment: mocks.updateRecruitment,
}));
vi.mock('../../../src/functions/guild-info/updateAchievements.js', () => ({
  updateAchievements: mocks.updateAchievements,
}));
vi.mock('../../../src/services/auditLog.js', () => ({ audit: mocks.audit }));
vi.mock('../../../src/services/logger.js', () => ({
  logger: { error: mocks.loggerError, warn: vi.fn(), info: vi.fn() },
}));

import { dispatch } from '../../../src/interactions/registry.js';
import { modals as guildInfoModals } from '../../../src/interactions/guildInfo.js';

function fakeModal({
  fields,
  hasRole = true,
}: {
  customId: string;
  fields: Record<string, string>;
  hasRole?: boolean;
}) {
  const member = Object.setPrototypeOf(
    { roles: { cache: { has: () => hasRole } } },
    GuildMember.prototype,
  );
  return {
    member,
    fields: {
      getTextInputValue: vi.fn((name: string) => fields[name] ?? ''),
    },
    deferReply: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    replied: false,
    deferred: false,
    client: {},
    user: {},
  };
}

describe('guild info modal handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const save of [
      mocks.saveAboutUs,
      mocks.saveRecruitmentSection,
      mocks.saveScheduleConfig,
      mocks.saveScheduleDay,
      mocks.saveGuildInfoLink,
      mocks.saveAchievementsTitle,
    ]) {
      save.mockReturnValue(true);
    }
    for (const update of [
      mocks.updateAboutUs,
      mocks.updateSchedule,
      mocks.updateRecruitment,
      mocks.updateAchievements,
      mocks.audit,
    ]) {
      update.mockResolvedValue(undefined);
    }
    mocks.validateGuildInfoUrl.mockImplementation((url: string) => url);
  });

  it('registers one officer-only guildinfo-edit prefix', () => {
    expect(guildInfoModals).toEqual([
      expect.objectContaining({ prefix: 'guildinfo-edit', officerOnly: true }),
    ]);
  });

  it('denies a non-officer through dispatch before any write', async () => {
    const interaction = fakeModal({
      customId: 'guildinfo-edit:about',
      fields: { title: 'Changed', content: 'Changed body' },
      hasRole: false,
    });

    await dispatch(
      guildInfoModals,
      'modal',
      interaction as unknown as ModalSubmitInteraction,
      'guildinfo-edit:about',
    );

    expect(mocks.saveAboutUs).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ flags: MessageFlags.Ephemeral }),
    );
  });

  it.each([
    {
      customId: 'guildinfo-edit:about',
      params: ['about'],
      fields: { title: 'About', content: 'Body' },
      save: mocks.saveAboutUs,
      saveArgs: ['About', 'Body'],
      update: mocks.updateAboutUs,
      target: 'About Us',
    },
    {
      customId: 'guildinfo-edit:link:raiderio',
      params: ['link', 'raiderio'],
      fields: { label: 'RIO', url: 'https://raider.io/guild' },
      save: mocks.saveGuildInfoLink,
      saveArgs: ['raiderio', 'RIO', 'https://raider.io/guild'],
      update: mocks.updateAboutUs,
      target: 'Raider.IO link',
    },
    {
      customId: 'guildinfo-edit:schedule-config',
      params: ['schedule-config'],
      fields: { title: 'Raids', timezone: 'Server time' },
      save: mocks.saveScheduleConfig,
      saveArgs: ['Raids', 'Server time'],
      update: mocks.updateSchedule,
      target: 'Schedule',
    },
    {
      customId: 'guildinfo-edit:schedule-day:wednesday',
      params: ['schedule-day', 'wednesday'],
      fields: { day: 'Wednesday', time: '20:00' },
      save: mocks.saveScheduleDay,
      saveArgs: ['wednesday', 'Wednesday', '20:00'],
      update: mocks.updateSchedule,
      target: 'Wednesday schedule',
    },
    {
      customId: 'guildinfo-edit:recruitment:contact',
      params: ['recruitment', 'contact'],
      fields: { title: 'Contact', content: 'Ask {{OVERLORDS}}' },
      save: mocks.saveRecruitmentSection,
      saveArgs: ['contact', 'Contact', 'Ask {{OVERLORDS}}'],
      update: mocks.updateRecruitment,
      target: 'Recruitment contact',
    },
    {
      customId: 'guildinfo-edit:achievements',
      params: ['achievements'],
      fields: { title: 'Past Achievements' },
      save: mocks.saveAchievementsTitle,
      saveArgs: ['Past Achievements'],
      update: mocks.updateAchievements,
      target: 'Achievements',
    },
  ])(
    'saves $customId and refreshes only its target renderer',
    async ({ params, fields, save, saveArgs, update, target }) => {
      const interaction = fakeModal({ customId: `guildinfo-edit:${params.join(':')}`, fields });

      await guildInfoModals[0]!.handle(interaction as unknown as ModalSubmitInteraction, params);

      expect(save).toHaveBeenCalledWith(...saveArgs);
      expect(update).toHaveBeenCalledWith(interaction.client);
      const allUpdates = [
        mocks.updateAboutUs,
        mocks.updateSchedule,
        mocks.updateRecruitment,
        mocks.updateAchievements,
      ];
      expect(allUpdates.reduce((count, renderer) => count + renderer.mock.calls.length, 0)).toBe(1);
      expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
      expect(mocks.audit).toHaveBeenCalledWith(interaction.user, 'updated guild info', target);
      expect(interaction.editReply).toHaveBeenCalledWith({ content: `${target} updated.` });
    },
  );

  it('rejects an invalid URL ephemerally before writing or refreshing', async () => {
    mocks.validateGuildInfoUrl.mockImplementation(() => {
      throw new Error('Link URL must use http or https.');
    });
    const interaction = fakeModal({
      customId: 'guildinfo-edit:link:raiderio',
      fields: { label: 'Bad', url: 'javascript:alert(1)' },
    });

    await guildInfoModals[0]!.handle(interaction as unknown as ModalSubmitInteraction, [
      'link',
      'raiderio',
    ]);

    expect(mocks.saveGuildInfoLink).not.toHaveBeenCalled();
    expect(mocks.updateAboutUs).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      content: 'Link URL must use http or https.',
      flags: MessageFlags.Ephemeral,
    });
  });

  it('rejects a missing selection ephemerally before any write', async () => {
    const interaction = fakeModal({
      customId: 'guildinfo-edit:link',
      fields: { label: 'RIO', url: 'https://raider.io/guild' },
    });

    await guildInfoModals[0]!.handle(interaction as unknown as ModalSubmitInteraction, ['link']);

    expect(mocks.saveGuildInfoLink).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ flags: MessageFlags.Ephemeral }),
    );
  });

  it('keeps a successful write and reports the targeted renderer failure', async () => {
    const error = new Error('Discord unavailable');
    mocks.updateAboutUs.mockRejectedValue(error);
    const interaction = fakeModal({
      customId: 'guildinfo-edit:link:raiderio',
      fields: { label: 'RIO', url: 'https://raider.io/guild' },
    });

    await guildInfoModals[0]!.handle(interaction as unknown as ModalSubmitInteraction, [
      'link',
      'raiderio',
    ]);

    expect(mocks.saveGuildInfoLink).toHaveBeenCalledOnce();
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: 'Saved, but the Guild Info message could not be refreshed. Run /guildinfo to retry.',
    });
    expect(mocks.loggerError).toHaveBeenCalledWith(
      'guild-info',
      expect.stringContaining('Discord unavailable'),
      error,
    );
  });

  it('reports a missing seeded record without refreshing', async () => {
    mocks.saveScheduleDay.mockReturnValue(false);
    const interaction = fakeModal({
      customId: 'guildinfo-edit:schedule-day:sunday',
      fields: { day: 'Sunday', time: '20:00' },
    });

    await guildInfoModals[0]!.handle(interaction as unknown as ModalSubmitInteraction, [
      'schedule-day',
      'sunday',
    ]);

    expect(mocks.updateSchedule).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ flags: MessageFlags.Ephemeral }),
    );
  });
});

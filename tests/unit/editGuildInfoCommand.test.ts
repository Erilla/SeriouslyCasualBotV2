import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js';

const mocks = vi.hoisted(() => ({
  requireOfficer: vi.fn(),
  getAboutUs: vi.fn(),
  getRecruitmentSection: vi.fn(),
  getScheduleConfig: vi.fn(),
  getScheduleDay: vi.fn(),
  getGuildInfoLink: vi.fn(),
  getAchievementsTitle: vi.fn(),
}));

vi.mock('../../src/utils.js', () => ({
  requireOfficer: mocks.requireOfficer,
}));

vi.mock('../../src/functions/guild-info/editableGuildInfo.js', () => ({
  getAboutUs: mocks.getAboutUs,
  getRecruitmentSection: mocks.getRecruitmentSection,
  getScheduleConfig: mocks.getScheduleConfig,
  getScheduleDay: mocks.getScheduleDay,
  getGuildInfoLink: mocks.getGuildInfoLink,
  getAchievementsTitle: mocks.getAchievementsTitle,
}));

import editGuildInfo from '../../src/commands/editguildinfo.js';

type ModalJson = {
  custom_id: string;
  components: Array<{
    components: Array<{ custom_id: string; value?: string; required?: boolean }>;
  }>;
};

function fakeChatInteraction(subcommand: string, selections: Record<string, string> = {}) {
  const interaction = {
    options: {
      getSubcommand: vi.fn().mockReturnValue(subcommand),
      getString: vi.fn((name: string) => selections[name] ?? null),
    },
    reply: vi.fn().mockResolvedValue(undefined),
    showModal: vi.fn().mockImplementation(async (modal) => {
      interaction.__modalShown = modal.toJSON();
    }),
    __modalShown: undefined as ModalJson | undefined,
  };
  return interaction;
}

function inputValue(modal: ModalJson, customId: string): string | undefined {
  return modal.components
    .flatMap((row) => row.components)
    .find((input) => input.custom_id === customId)?.value;
}

describe('/editguildinfo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireOfficer.mockResolvedValue(true);
    mocks.getAboutUs.mockReturnValue({ key: 'aboutus', title: 'About Us', content: 'Guild body' });
    mocks.getRecruitmentSection.mockReturnValue({
      key: 'recruitment_contact',
      title: 'Contact',
      content: 'Contact {{OVERLORDS}} if you have any questions.',
    });
    mocks.getScheduleConfig.mockReturnValue({
      title: 'Raid Schedule',
      timezone: 'Server Time (CEST +1)',
    });
    mocks.getScheduleDay.mockReturnValue({
      id: 1,
      day: 'Wednesday',
      time: '20:00 - 23:00',
      sort_order: 1,
    });
    mocks.getGuildInfoLink.mockReturnValue({
      id: 1,
      label: 'RIO',
      url: 'https://raider.io/guilds/eu/silvermoon/SeriouslyCasual',
      emoji_id: null,
    });
    mocks.getAchievementsTitle.mockReturnValue({
      key: 'achievements_title',
      title: 'Current Progress',
      content: '',
    });
  });

  it('declares exactly the six editor subcommands and their required choices', () => {
    const command = editGuildInfo.data.toJSON();
    expect(command.name).toBe('editguildinfo');
    expect(command.options?.map((option) => option.name)).toEqual([
      'about',
      'schedule-config',
      'schedule-day',
      'recruitment',
      'link',
      'achievements',
    ]);
    expect(
      command.options?.find((option) => option.name === 'schedule-day')?.options?.[0],
    ).toMatchObject({
      name: 'day',
      required: true,
      choices: [
        { name: 'Wednesday', value: 'wednesday' },
        { name: 'Sunday', value: 'sunday' },
      ],
    });
    expect(
      command.options?.find((option) => option.name === 'recruitment')?.options?.[0],
    ).toMatchObject({
      name: 'section',
      required: true,
      choices: [
        { name: 'Who We Are', value: 'who' },
        { name: 'What We Want', value: 'want' },
        { name: 'What We Give', value: 'give' },
        { name: 'Contact', value: 'contact' },
      ],
    });
    expect(command.options?.find((option) => option.name === 'link')?.options?.[0]).toMatchObject({
      name: 'link',
      required: true,
      choices: [
        { name: 'Raider.IO', value: 'raiderio' },
        { name: 'WoWProgress', value: 'wowprogress' },
        { name: 'Warcraft Logs', value: 'warcraftlogs' },
      ],
    });
  });

  it.each([
    {
      subcommand: 'about',
      selections: {},
      getter: mocks.getAboutUs,
      getterArg: undefined,
      customId: 'guildinfo-edit:about',
      values: { title: 'About Us', content: 'Guild body' },
    },
    {
      subcommand: 'schedule-config',
      selections: {},
      getter: mocks.getScheduleConfig,
      getterArg: undefined,
      customId: 'guildinfo-edit:schedule-config',
      values: { title: 'Raid Schedule', timezone: 'Server Time (CEST +1)' },
    },
    {
      subcommand: 'schedule-day',
      selections: { day: 'wednesday' },
      getter: mocks.getScheduleDay,
      getterArg: 'wednesday',
      customId: 'guildinfo-edit:schedule-day:wednesday',
      values: { day: 'Wednesday', time: '20:00 - 23:00' },
    },
    {
      subcommand: 'recruitment',
      selections: { section: 'contact' },
      getter: mocks.getRecruitmentSection,
      getterArg: 'contact',
      customId: 'guildinfo-edit:recruitment:contact',
      values: {
        title: 'Contact',
        content: 'Contact {{OVERLORDS}} if you have any questions.',
      },
    },
    {
      subcommand: 'link',
      selections: { link: 'raiderio' },
      getter: mocks.getGuildInfoLink,
      getterArg: 'raiderio',
      customId: 'guildinfo-edit:link:raiderio',
      values: {
        label: 'RIO',
        url: 'https://raider.io/guilds/eu/silvermoon/SeriouslyCasual',
      },
    },
    {
      subcommand: 'achievements',
      selections: {},
      getter: mocks.getAchievementsTitle,
      getterArg: undefined,
      customId: 'guildinfo-edit:achievements',
      values: { title: 'Current Progress' },
    },
  ])(
    'opens a prefilled $subcommand modal for the selected record',
    async ({ subcommand, selections, getter, getterArg, customId, values }) => {
      const interaction = fakeChatInteraction(subcommand, selections);

      await editGuildInfo.execute(interaction as unknown as ChatInputCommandInteraction);

      if (getterArg === undefined) expect(getter).toHaveBeenCalledWith();
      else expect(getter).toHaveBeenCalledWith(getterArg);
      expect(interaction.__modalShown?.custom_id).toBe(customId);
      for (const [inputId, value] of Object.entries(values)) {
        expect(inputValue(interaction.__modalShown!, inputId)).toBe(value);
      }
      expect(
        interaction.__modalShown?.components.every(
          (row) => row.components.length === 1 && row.components[0]!.required === true,
        ),
      ).toBe(true);
      expect(interaction.__modalShown?.components.length).toBeLessThanOrEqual(2);
    },
  );

  it('checks the runtime officer gate before reading or showing content', async () => {
    mocks.requireOfficer.mockResolvedValue(false);
    const interaction = fakeChatInteraction('about');

    await editGuildInfo.execute(interaction as unknown as ChatInputCommandInteraction);

    expect(mocks.getAboutUs).not.toHaveBeenCalled();
    expect(interaction.showModal).not.toHaveBeenCalled();
  });

  it('replies ephemerally when the selected seeded record is missing', async () => {
    mocks.getScheduleDay.mockReturnValue(null);
    const interaction = fakeChatInteraction('schedule-day', { day: 'sunday' });

    await editGuildInfo.execute(interaction as unknown as ChatInputCommandInteraction);

    expect(interaction.showModal).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ flags: MessageFlags.Ephemeral }),
    );
  });
});

import {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { requireOfficer } from '../utils.js';
import {
  getAboutUs,
  getAchievementsTitle,
  getGuildInfoLink,
  getRecruitmentSection,
  getScheduleConfig,
  getScheduleDay,
  type LinkChoice,
  type RecruitmentChoice,
  type ScheduleDayChoice,
} from '../functions/guild-info/editableGuildInfo.js';

type ModalInput = {
  id: string;
  label: string;
  value: string;
  style?: TextInputStyle;
};

function buildModal(customId: string, title: string, inputs: ModalInput[]): ModalBuilder {
  const modal = new ModalBuilder().setCustomId(customId).setTitle(title);
  modal.addComponents(
    inputs.map((input) =>
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(input.id)
          .setLabel(input.label)
          .setStyle(input.style ?? TextInputStyle.Short)
          .setRequired(true)
          .setValue(input.value),
      ),
    ),
  );
  return modal;
}

async function missingRecord(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.reply({
    content: 'The selected Guild Info record could not be found.',
    flags: MessageFlags.Ephemeral,
  });
}

export default {
  data: new SlashCommandBuilder()
    .setName('editguildinfo')
    .setDescription('Edit Guild Info embed content')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) => sub.setName('about').setDescription('Edit About Us'))
    .addSubcommand((sub) =>
      sub.setName('schedule-config').setDescription('Edit schedule title and timezone'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('schedule-day')
        .setDescription('Edit a seeded schedule day')
        .addStringOption((option) =>
          option
            .setName('day')
            .setDescription('Schedule day')
            .setRequired(true)
            .addChoices(
              { name: 'Wednesday', value: 'wednesday' },
              { name: 'Sunday', value: 'sunday' },
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('recruitment')
        .setDescription('Edit a recruitment section')
        .addStringOption((option) =>
          option
            .setName('section')
            .setDescription('Recruitment section')
            .setRequired(true)
            .addChoices(
              { name: 'Who We Are', value: 'who' },
              { name: 'What We Want', value: 'want' },
              { name: 'What We Give', value: 'give' },
              { name: 'Contact', value: 'contact' },
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('link')
        .setDescription('Edit an About Us link')
        .addStringOption((option) =>
          option
            .setName('link')
            .setDescription('Guild link')
            .setRequired(true)
            .addChoices(
              { name: 'Raider.IO', value: 'raiderio' },
              { name: 'WoWProgress', value: 'wowprogress' },
              { name: 'Warcraft Logs', value: 'warcraftlogs' },
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('achievements').setDescription('Edit the achievements heading'),
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!(await requireOfficer(interaction))) return;

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'about') {
      const row = getAboutUs();
      if (!row) return missingRecord(interaction);
      await interaction.showModal(
        buildModal('guildinfo-edit:about', 'Edit About Us', [
          { id: 'title', label: 'Heading', value: row.title ?? '' },
          { id: 'content', label: 'Content', value: row.content, style: TextInputStyle.Paragraph },
        ]),
      );
      return;
    }

    if (subcommand === 'schedule-config') {
      const row = getScheduleConfig();
      if (!row) return missingRecord(interaction);
      await interaction.showModal(
        buildModal('guildinfo-edit:schedule-config', 'Edit Schedule', [
          { id: 'title', label: 'Heading', value: row.title },
          { id: 'timezone', label: 'Timezone', value: row.timezone },
        ]),
      );
      return;
    }

    if (subcommand === 'schedule-day') {
      const choice = interaction.options.getString('day', true) as ScheduleDayChoice;
      const row = getScheduleDay(choice);
      if (!row) return missingRecord(interaction);
      await interaction.showModal(
        buildModal(`guildinfo-edit:schedule-day:${choice}`, 'Edit Schedule Day', [
          { id: 'day', label: 'Day', value: row.day },
          { id: 'time', label: 'Time', value: row.time },
        ]),
      );
      return;
    }

    if (subcommand === 'recruitment') {
      const choice = interaction.options.getString('section', true) as RecruitmentChoice;
      const row = getRecruitmentSection(choice);
      if (!row) return missingRecord(interaction);
      await interaction.showModal(
        buildModal(`guildinfo-edit:recruitment:${choice}`, 'Edit Recruitment', [
          { id: 'title', label: 'Heading', value: row.title ?? '' },
          { id: 'content', label: 'Content', value: row.content, style: TextInputStyle.Paragraph },
        ]),
      );
      return;
    }

    if (subcommand === 'link') {
      const choice = interaction.options.getString('link', true) as LinkChoice;
      const row = getGuildInfoLink(choice);
      if (!row) return missingRecord(interaction);
      await interaction.showModal(
        buildModal(`guildinfo-edit:link:${choice}`, 'Edit Guild Link', [
          { id: 'label', label: 'Label', value: row.label },
          { id: 'url', label: 'URL', value: row.url },
        ]),
      );
      return;
    }

    if (subcommand === 'achievements') {
      const row = getAchievementsTitle();
      if (!row) return missingRecord(interaction);
      await interaction.showModal(
        buildModal('guildinfo-edit:achievements', 'Edit Achievements', [
          { id: 'title', label: 'Heading', value: row.title ?? '' },
        ]),
      );
      return;
    }

    await interaction.reply({
      content: 'Unknown Guild Info editor.',
      flags: MessageFlags.Ephemeral,
    });
  },
};

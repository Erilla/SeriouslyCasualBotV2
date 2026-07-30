import { MessageFlags, type Client, type ModalSubmitInteraction } from 'discord.js';
import type { ModalHandler } from './registry.js';
import {
  saveAboutUs,
  saveAchievementsTitle,
  saveGuildInfoLink,
  saveRecruitmentSection,
  saveScheduleConfig,
  saveScheduleDay,
  validateGuildInfoUrl,
  type LinkChoice,
  type RecruitmentChoice,
  type ScheduleDayChoice,
} from '../functions/guild-info/editableGuildInfo.js';
import { updateAboutUs } from '../functions/guild-info/updateAboutUs.js';
import { updateSchedule } from '../functions/guild-info/updateSchedule.js';
import { updateRecruitment } from '../functions/guild-info/updateRecruitment.js';
import { updateAchievements } from '../functions/guild-info/updateAchievements.js';
import { audit } from '../services/auditLog.js';
import { logger } from '../services/logger.js';

type Edit = {
  save(): boolean;
  refresh(client: Client): Promise<void>;
  target: string;
};

const scheduleDays = new Set<ScheduleDayChoice>(['wednesday', 'sunday']);
const recruitmentSections = new Set<RecruitmentChoice>(['who', 'want', 'give', 'contact']);
const links = new Set<LinkChoice>(['raiderio', 'wowprogress', 'warcraftlogs']);

const scheduleTargets: Record<ScheduleDayChoice, string> = {
  wednesday: 'Wednesday schedule',
  sunday: 'Sunday schedule',
};
const recruitmentTargets: Record<RecruitmentChoice, string> = {
  who: 'Recruitment who',
  want: 'Recruitment want',
  give: 'Recruitment give',
  contact: 'Recruitment contact',
};
const linkTargets: Record<LinkChoice, string> = {
  raiderio: 'Raider.IO link',
  wowprogress: 'WoWProgress link',
  warcraftlogs: 'Warcraft Logs link',
};

function isScheduleDay(value: string | undefined): value is ScheduleDayChoice {
  return value !== undefined && scheduleDays.has(value as ScheduleDayChoice);
}

function isRecruitmentSection(value: string | undefined): value is RecruitmentChoice {
  return value !== undefined && recruitmentSections.has(value as RecruitmentChoice);
}

function isLink(value: string | undefined): value is LinkChoice {
  return value !== undefined && links.has(value as LinkChoice);
}

function parseEdit(interaction: ModalSubmitInteraction, params: string[]): Edit | null {
  const [kind, selection] = params;

  if (kind === 'about' && params.length === 1) {
    const title = interaction.fields.getTextInputValue('title');
    const content = interaction.fields.getTextInputValue('content');
    return {
      save: () => saveAboutUs(title, content),
      refresh: updateAboutUs,
      target: 'About Us',
    };
  }

  if (kind === 'schedule-config' && params.length === 1) {
    const title = interaction.fields.getTextInputValue('title');
    const timezone = interaction.fields.getTextInputValue('timezone');
    return {
      save: () => saveScheduleConfig(title, timezone),
      refresh: updateSchedule,
      target: 'Schedule',
    };
  }

  if (kind === 'schedule-day' && params.length === 2 && isScheduleDay(selection)) {
    const day = interaction.fields.getTextInputValue('day');
    const time = interaction.fields.getTextInputValue('time');
    return {
      save: () => saveScheduleDay(selection, day, time),
      refresh: updateSchedule,
      target: scheduleTargets[selection],
    };
  }

  if (kind === 'recruitment' && params.length === 2 && isRecruitmentSection(selection)) {
    const title = interaction.fields.getTextInputValue('title');
    const content = interaction.fields.getTextInputValue('content');
    return {
      save: () => saveRecruitmentSection(selection, title, content),
      refresh: updateRecruitment,
      target: recruitmentTargets[selection],
    };
  }

  if (kind === 'link' && params.length === 2 && isLink(selection)) {
    const label = interaction.fields.getTextInputValue('label');
    const url = interaction.fields.getTextInputValue('url');
    validateGuildInfoUrl(url);
    return {
      save: () => saveGuildInfoLink(selection, label, url),
      refresh: updateAboutUs,
      target: linkTargets[selection],
    };
  }

  if (kind === 'achievements' && params.length === 1) {
    const title = interaction.fields.getTextInputValue('title');
    return {
      save: () => saveAchievementsTitle(title),
      refresh: updateAchievements,
      target: 'Achievements',
    };
  }

  return null;
}

async function handle(interaction: ModalSubmitInteraction, params: string[]): Promise<void> {
  let edit: Edit | null;
  try {
    edit = parseEdit(interaction, params);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
    return;
  }

  if (!edit) {
    await interaction.reply({
      content: 'The selected Guild Info editor is not available.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!edit.save()) {
    await interaction.reply({
      content: 'The selected Guild Info record could not be found.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    await edit.refresh(interaction.client);
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error(
      'guild-info',
      `Guild Info refresh failed after updating ${edit.target}: ${err.message}`,
      err,
    );
    await interaction.editReply({
      content: 'Saved, but the Guild Info message could not be refreshed. Run /guildinfo to retry.',
    });
    return;
  }

  await audit(interaction.user, 'updated guild info', edit.target);
  await interaction.editReply({ content: `${edit.target} updated.` });
}

export const modals: ModalHandler[] = [{ prefix: 'guildinfo-edit', officerOnly: true, handle }];

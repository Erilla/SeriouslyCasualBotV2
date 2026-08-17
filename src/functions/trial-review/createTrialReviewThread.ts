import {
  type Client,
  type ForumChannel,
  ChannelType,
  ThreadAutoArchiveDuration,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { config } from '../../config.js';
import { logger } from '../../services/logger.js';
import { getOrCreateChannel } from '../channels.js';
import { addOverlordsToThread } from '../raids/overlords.js';
import { ensureRaiderForTrial } from '../raids/ensureTrialRaiders.js';
import { generateTrialLogsContent } from './generateTrialLogs.js';
import { scheduleTrialAlerts } from './scheduleTrialAlerts.js';
import { ensureTrialForumTags } from './trialForumTags.js';
import type { TrialAlertRow, TrialRow } from '../../types/index.js';

export interface TrialData {
  characterName: string;
  role: string;
  startDate: string;
  applicationId?: number;
  /** Whose Discord account this trial is, when the officer named them. */
  discordUserId?: string;
}

/**
 * Whose Discord account a new trial belongs to.
 *
 * The officer's pick wins outright. The `raiders` lookup is only a fallback and is
 * expected to miss: a manually created trial is precisely the case where the
 * character has not been through a wowaudit sync yet, which is why the command
 * offers a user picker at all. Null means departure notifications stay off for this
 * trial until someone links it.
 */
export function resolveTrialDiscordUserId(
  characterName: string,
  picked: string | undefined,
): string | null {
  if (picked) return picked;

  const raider = getDatabase()
    .prepare(
      'SELECT discord_user_id FROM raiders WHERE character_name = ? AND discord_user_id IS NOT NULL',
    )
    .get(characterName) as { discord_user_id: string } | undefined;

  return raider?.discord_user_id ?? null;
}

/**
 * Convert a Date to a Discord epoch timestamp string.
 * Styles: 'D' = long date, 'R' = relative, 'f' = short datetime.
 */
function toDiscordTimestamp(date: Date, style: 'D' | 'R' | 'f' = 'D'): string {
  return `<t:${Math.floor(date.getTime() / 1000)}:${style}>`;
}

/**
 * Build the review message content for a trial.
 */
export function finalReviewLabel(startDate: string, finalReviewDate: Date): string {
  const start = new Date(`${startDate}T00:00:00Z`);
  const totalWeeks = Math.round(
    (finalReviewDate.getTime() - start.getTime()) / (7 * 24 * 60 * 60 * 1000),
  );
  const extensionWeeks = totalWeeks - 6;
  return extensionWeeks > 0
    ? `${totalWeeks}-week review (${extensionWeeks}-week extension)`
    : `${totalWeeks}-week review`;
}

export function reviewDatesFromAlerts(
  alerts: TrialAlertRow[],
  fallbackStartDate: string,
): { twoWeek: Date; fourWeek: Date; sixWeek: Date } {
  const alertDates = new Map(alerts.map((alert) => [alert.alert_name, alert.alert_date]));
  const dateFor = (alertName: string) =>
    new Date(`${alertDates.get(alertName) ?? fallbackStartDate}T00:00:00Z`);

  return {
    twoWeek: dateFor('2_week'),
    fourWeek: dateFor('4_week'),
    sixWeek: dateFor('6_week'),
  };
}

export function buildReviewMessage(
  characterName: string,
  role: string,
  startDate: string,
  twoWeek: Date,
  fourWeek: Date,
  sixWeek: Date,
): string {
  const startDateObj = new Date(startDate + 'T00:00:00Z');
  const finalLabel = finalReviewLabel(startDate, sixWeek);

  return [
    `**Trial Review: ${characterName}**`,
    '',
    `**Role:** ${role}`,
    `**Start Date:** ${toDiscordTimestamp(startDateObj)}`,
    '',
    `**Review Schedule:**`,
    `  2-week review: ${toDiscordTimestamp(twoWeek)} (${toDiscordTimestamp(twoWeek, 'R')})`,
    `  4-week review: ${toDiscordTimestamp(fourWeek)} (${toDiscordTimestamp(fourWeek, 'R')})`,
    `  ${finalLabel}: ${toDiscordTimestamp(sixWeek)} (${toDiscordTimestamp(sixWeek, 'R')})`,
  ].join('\n');
}

import { calculateReviewDates } from './dateCalculations.js';
export { calculateReviewDates } from './dateCalculations.js';

/**
 * Build the action buttons row for a trial thread.
 */
export function buildTrialButtons(trialId: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`trial:update_info:${trialId}`)
      .setLabel('Update Info')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`trial:extend:${trialId}`)
      .setLabel('Extend 1 Week')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`trial:mark_promote:${trialId}`)
      .setLabel('Mark for Promotion')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`trial:close:${trialId}`)
      .setLabel('Close Trial')
      .setStyle(ButtonStyle.Danger),
  );
}

/**
 * Get or create the trial-reviews forum channel.
 */
async function getOrCreateTrialForum(client: Client): Promise<ForumChannel> {
  const guild = client.guilds.cache.get(config.guildId);
  if (!guild) throw new Error('Guild not found');

  const forum = await getOrCreateChannel(guild, {
    name: 'trial-reviews',
    type: ChannelType.GuildForum,
    categoryName: 'Overlords',
    configKey: 'trial_reviews_forum_id',
  });

  return ensureTrialForumTags(forum);
}

/**
 * Create a trial review thread with review message, buttons, and WarcraftLogs links.
 */
export async function createTrialReviewThread(
  client: Client,
  trialData: TrialData,
): Promise<TrialRow> {
  const db = getDatabase();

  const { characterName, role, startDate, applicationId, discordUserId } = trialData;
  const { twoWeek, fourWeek, sixWeek } = calculateReviewDates(startDate);
  const fmt = (d: Date) => d.toISOString().split('T')[0];

  const trialDiscordUserId = resolveTrialDiscordUserId(characterName, discordUserId);

  // Insert trial record
  const result = db
    .prepare(
      `INSERT INTO trials (character_name, role, start_date, application_id, status, discord_user_id)
       VALUES (?, ?, ?, ?, 'active', ?)`,
    )
    .run(characterName, role, startDate, applicationId ?? null, trialDiscordUserId);

  const trialId = result.lastInsertRowid as number;

  // A trial is a roster member, so give them a `raiders` row now. This is the one
  // place both trial-creation paths (an accepted application and `/trials create`)
  // pass through, so it is the only non-sync writer of trial roster rows. Doing it
  // here matters because the roster sync only runs once a day at 06:00 via
  // `dailyMaintenance` -- without this a trial created in the evening has no row,
  // and so no signup ping, until the next morning.
  //
  // Never fatal: a missing roster row must not cost us the review thread, and the
  // daily sync ensures it anyway.
  try {
    ensureRaiderForTrial(db, {
      character_name: characterName,
      discord_user_id: trialDiscordUserId,
      application_id: applicationId ?? null,
    });
  } catch (error) {
    logger.warn(
      'Trials',
      `Failed to add "${characterName}" to the roster for trial #${trialId}: ${error}`,
    );
  }

  // Insert trial alerts
  const insertAlert = db.prepare(
    'INSERT INTO trial_alerts (trial_id, alert_name, alert_date, alerted) VALUES (?, ?, ?, 0)',
  );

  insertAlert.run(trialId, '2_week', fmt(twoWeek));
  insertAlert.run(trialId, '4_week', fmt(fourWeek));
  insertAlert.run(trialId, '6_week', fmt(sixWeek));

  // Create forum thread
  const forum = await getOrCreateTrialForum(client);
  const activeTag = forum.availableTags.find((t) => t.name === 'Active');
  const reviewContent = buildReviewMessage(
    characterName,
    role,
    startDate,
    twoWeek,
    fourWeek,
    sixWeek,
  );

  const buttonRow = buildTrialButtons(trialId);

  const thread = await forum.threads.create({
    name: characterName,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
    appliedTags: activeTag ? [activeTag.id] : [],
    message: {
      content: reviewContent,
      components: [buttonRow],
    },
  });

  // Fetch and post WarcraftLogs links
  try {
    const logsContent = await generateTrialLogsContent(characterName);
    if (logsContent) {
      const logsMsg = await thread.send(logsContent);
      db.prepare('UPDATE trials SET logs_message_id = ? WHERE id = ?').run(logsMsg.id, trialId);
    }
  } catch (error) {
    logger.warn('Trials', `Failed to fetch WarcraftLogs for trial #${trialId}: ${error}`);
  }

  // Add overlords to thread
  await addOverlordsToThread(thread);

  // Store thread_id
  db.prepare('UPDATE trials SET thread_id = ? WHERE id = ?').run(thread.id, trialId);

  // Schedule alerts
  scheduleTrialAlerts(client, trialId);

  const trial = db.prepare('SELECT * FROM trials WHERE id = ?').get(trialId) as TrialRow;

  logger.info('Trials', `Created trial review thread for "${characterName}" (trial #${trialId})`);

  return trial;
}

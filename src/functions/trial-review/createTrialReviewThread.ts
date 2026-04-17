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
import { addOverlordsToThread } from '../raids/overlords.js';
import { generateTrialLogsContent } from './generateTrialLogs.js';
import { scheduleTrialAlerts } from './scheduleTrialAlerts.js';
import type { TrialRow } from '../../types/index.js';

export interface TrialData {
  characterName: string;
  role: string;
  startDate: string;
  applicationId?: number;
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
export function buildReviewMessage(
  characterName: string,
  role: string,
  startDate: string,
  twoWeek: Date,
  fourWeek: Date,
  sixWeek: Date,
): string {
  const startDateObj = new Date(startDate + 'T00:00:00Z');

  return [
    `**Trial Review: ${characterName}**`,
    '',
    `**Role:** ${role}`,
    `**Start Date:** ${toDiscordTimestamp(startDateObj)}`,
    '',
    `**Review Schedule:**`,
    `  2-week review: ${toDiscordTimestamp(twoWeek)} (${toDiscordTimestamp(twoWeek, 'R')})`,
    `  4-week review: ${toDiscordTimestamp(fourWeek)} (${toDiscordTimestamp(fourWeek, 'R')})`,
    `  6-week review: ${toDiscordTimestamp(sixWeek)} (${toDiscordTimestamp(sixWeek, 'R')})`,
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
  const db = getDatabase();
  const guild = client.guilds.cache.get(config.guildId);
  if (!guild) throw new Error('Guild not found');

  let forumId = (
    db.prepare('SELECT value FROM config WHERE key = ?').get('trial_reviews_forum_id') as
      | { value: string }
      | undefined
  )?.value;

  let forum: ForumChannel | null = null;

  if (forumId) {
    const existing = guild.channels.cache.get(forumId);
    if (existing && existing.type === ChannelType.GuildForum) {
      forum = existing as ForumChannel;
    }
  }

  if (!forum) {
    forum = await guild.channels.create({
      name: 'trial-reviews',
      type: ChannelType.GuildForum,
    });
    forumId = forum.id;
    db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(
      'trial_reviews_forum_id',
      forumId,
    );
    logger.info('Trials', `Created trial-reviews forum: ${forumId}`);
  }

  return forum;
}

/**
 * Create a trial review thread with review message, buttons, and WarcraftLogs links.
 */
export async function createTrialReviewThread(
  client: Client,
  trialData: TrialData,
): Promise<TrialRow> {
  const db = getDatabase();

  const { characterName, role, startDate, applicationId } = trialData;
  const { twoWeek, fourWeek, sixWeek } = calculateReviewDates(startDate);
  const fmt = (d: Date) => d.toISOString().split('T')[0];

  // Insert trial record
  const result = db
    .prepare(
      `INSERT INTO trials (character_name, role, start_date, application_id, status)
       VALUES (?, ?, ?, ?, 'active')`,
    )
    .run(characterName, role, startDate, applicationId ?? null);

  const trialId = result.lastInsertRowid as number;

  // Insert trial alerts
  const insertAlert = db.prepare(
    'INSERT INTO trial_alerts (trial_id, alert_name, alert_date, alerted) VALUES (?, ?, ?, 0)',
  );

  insertAlert.run(trialId, '2_week', fmt(twoWeek));
  insertAlert.run(trialId, '4_week', fmt(fourWeek));
  insertAlert.run(trialId, '6_week', fmt(sixWeek));

  // Create forum thread
  const forum = await getOrCreateTrialForum(client);
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
      db.prepare('UPDATE trials SET logs_message_id = ? WHERE id = ?').run(
        logsMsg.id,
        trialId,
      );
    }
  } catch (error) {
    logger.warn(
      'Trials',
      `Failed to fetch WarcraftLogs for trial #${trialId}: ${error}`,
    );
  }

  // Add overlords to thread
  await addOverlordsToThread(thread);

  // Store thread_id
  db.prepare('UPDATE trials SET thread_id = ? WHERE id = ?').run(
    thread.id,
    trialId,
  );

  // Schedule alerts
  scheduleTrialAlerts(client, trialId);

  const trial = db
    .prepare('SELECT * FROM trials WHERE id = ?')
    .get(trialId) as TrialRow;

  logger.info(
    'Trials',
    `Created trial review thread for "${characterName}" (trial #${trialId})`,
  );

  return trial;
}

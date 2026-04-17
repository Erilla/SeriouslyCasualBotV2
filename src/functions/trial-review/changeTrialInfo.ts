import type { Client, AnyThreadChannel } from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';
import { scheduleTrialAlerts } from './scheduleTrialAlerts.js';
import {
  buildReviewMessage,
  calculateReviewDates,
  buildTrialButtons,
} from './createTrialReviewThread.js';
import type { TrialRow } from '../../types/index.js';

export interface TrialInfoUpdates {
  characterName?: string;
  role?: string;
  startDate?: string;
}

/**
 * Update trial info (character name, role, start date).
 * If start_date changes, recalculate and reschedule alerts.
 * Updates the review message in the thread.
 */
export async function changeTrialInfo(
  client: Client,
  trialId: number,
  updates: TrialInfoUpdates,
): Promise<void> {
  const db = getDatabase();

  const trial = db
    .prepare('SELECT * FROM trials WHERE id = ?')
    .get(trialId) as TrialRow | undefined;

  if (!trial) throw new Error(`Trial #${trialId} not found`);

  const newCharName = updates.characterName ?? trial.character_name;
  const newRole = updates.role ?? trial.role;
  const newStartDate = updates.startDate ?? trial.start_date;

  // Update the trial record
  db.prepare(
    'UPDATE trials SET character_name = ?, role = ?, start_date = ? WHERE id = ?',
  ).run(newCharName, newRole, newStartDate, trialId);

  // If start_date changed, recalculate alerts
  if (updates.startDate && updates.startDate !== trial.start_date) {
    const { twoWeek, fourWeek, sixWeek } = calculateReviewDates(newStartDate);
    const fmt = (d: Date) => d.toISOString().split('T')[0];

    // Update unalerted alerts with new dates
    const alertNames = ['2_week', '4_week', '6_week'] as const;
    const newDates = [fmt(twoWeek), fmt(fourWeek), fmt(sixWeek)];

    for (let i = 0; i < alertNames.length; i++) {
      db.prepare(
        'UPDATE trial_alerts SET alert_date = ? WHERE trial_id = ? AND alert_name = ? AND alerted = 0',
      ).run(newDates[i], trialId, alertNames[i]);
    }

    // Re-schedule alerts
    scheduleTrialAlerts(client, trialId);
  }

  // Update the thread name if character name changed
  if (updates.characterName && updates.characterName !== trial.character_name && trial.thread_id) {
    try {
      const guild = client.guilds.cache.first();
      if (guild) {
        const thread = await guild.channels.fetch(trial.thread_id);
        if (thread?.isThread()) {
          await thread.setName(newCharName);
        }
      }
    } catch (error) {
      logger.warn(
        'Trials',
        `Failed to rename thread for trial #${trialId}: ${error}`,
      );
    }
  }

  // Update the review message
  if (trial.thread_id) {
    try {
      const guild = client.guilds.cache.first();
      if (!guild) return;

      const channel = await guild.channels.fetch(trial.thread_id);
      if (!channel || !channel.isThread()) return;
      const thread = channel as AnyThreadChannel;

      const { twoWeek, fourWeek, sixWeek } = calculateReviewDates(newStartDate);
      const content = buildReviewMessage(
        newCharName,
        newRole,
        newStartDate,
        twoWeek,
        fourWeek,
        sixWeek,
      );

      const starterMessage = await thread.fetchStarterMessage();
      if (starterMessage) {
        await starterMessage.edit({
          content,
          components: [buildTrialButtons(trialId)],
        });
      }
    } catch (error) {
      logger.warn(
        'Trials',
        `Failed to update review message for trial #${trialId}: ${error}`,
      );
    }
  }

  logger.info(
    'Trials',
    `Updated trial #${trialId}: name=${newCharName}, role=${newRole}, start=${newStartDate}`,
  );
}

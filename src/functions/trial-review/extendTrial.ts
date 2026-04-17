import type { Client, AnyThreadChannel } from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';
import { scheduleTrialAlerts } from './scheduleTrialAlerts.js';
import {
  buildReviewMessage,
  calculateReviewDates,
  buildTrialButtons,
} from './createTrialReviewThread.js';
import type { TrialRow, TrialAlertRow } from '../../types/index.js';

/**
 * Extend a trial by 7 days - shifts all unalerted alert dates forward.
 * Updates the review message in the thread.
 */
export async function extendTrial(client: Client, trialId: number): Promise<void> {
  const db = getDatabase();

  const trial = db
    .prepare('SELECT * FROM trials WHERE id = ?')
    .get(trialId) as TrialRow | undefined;

  if (!trial) throw new Error(`Trial #${trialId} not found`);
  if (trial.status !== 'active') throw new Error(`Trial #${trialId} is not active`);

  // Extend all unalerted alerts by 7 days
  const unalertedAlerts = db
    .prepare('SELECT * FROM trial_alerts WHERE trial_id = ? AND alerted = 0')
    .all(trialId) as TrialAlertRow[];

  for (const alert of unalertedAlerts) {
    const oldDate = new Date(alert.alert_date + 'T00:00:00Z');
    oldDate.setUTCDate(oldDate.getUTCDate() + 7);
    const newDate = oldDate.toISOString().split('T')[0];

    db.prepare('UPDATE trial_alerts SET alert_date = ? WHERE id = ?').run(
      newDate,
      alert.id,
    );
  }

  // Re-schedule alerts with new dates
  scheduleTrialAlerts(client, trialId);

  // Update the review message in the thread
  if (trial.thread_id) {
    try {
      const guild = client.guilds.cache.first();
      if (!guild) return;

      const channel = await guild.channels.fetch(trial.thread_id);
      if (!channel || !channel.isThread()) return;
      const thread = channel as AnyThreadChannel;

      // Recalculate display dates from the updated alerts
      const updatedAlerts = db
        .prepare('SELECT * FROM trial_alerts WHERE trial_id = ? ORDER BY alert_date')
        .all(trialId) as TrialAlertRow[];

      // Use the alert dates for display (they may have been extended multiple times)
      const alertDates = updatedAlerts.reduce(
        (acc, a) => {
          acc[a.alert_name] = a.alert_date;
          return acc;
        },
        {} as Record<string, string>,
      );

      const twoWeek = new Date((alertDates['2_week'] || trial.start_date) + 'T00:00:00Z');
      const fourWeek = new Date((alertDates['4_week'] || trial.start_date) + 'T00:00:00Z');
      const sixWeek = new Date((alertDates['6_week'] || trial.start_date) + 'T00:00:00Z');

      const content = buildReviewMessage(
        trial.character_name,
        trial.role,
        trial.start_date,
        twoWeek,
        fourWeek,
        sixWeek,
      );

      // Fetch the first message (starter message) and edit it
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
    `Extended trial #${trialId} (${trial.character_name}) by 7 days`,
  );
}

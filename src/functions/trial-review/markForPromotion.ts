import type { Client, TextChannel } from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';
import { schedulePromoteAlert } from './scheduleTrialAlerts.js';
import type { TrialRow, PromoteAlertRow } from '../../types/index.js';

/**
 * Mark a trial for promotion. Schedules a promote alert for the next day.
 */
export async function markForPromotion(
  client: Client,
  trialId: number,
): Promise<void> {
  const db = getDatabase();

  const trial = db
    .prepare('SELECT * FROM trials WHERE id = ?')
    .get(trialId) as TrialRow | undefined;

  if (!trial) throw new Error(`Trial #${trialId} not found`);
  if (trial.status !== 'active') throw new Error(`Trial #${trialId} is not active`);

  // Check if already marked for promotion
  const existingPromote = db
    .prepare('SELECT * FROM promote_alerts WHERE trial_id = ?')
    .get(trialId) as PromoteAlertRow | undefined;

  if (existingPromote) {
    throw new Error(`Trial #${trialId} is already marked for promotion`);
  }

  // Schedule promote alert for tomorrow
  const promoteDate = new Date();
  promoteDate.setUTCDate(promoteDate.getUTCDate() + 1);
  const promoteDateStr = promoteDate.toISOString().split('T')[0];

  if (!trial.thread_id) {
    throw new Error(`Trial #${trialId} has no thread`);
  }

  schedulePromoteAlert(client, trialId, trial.thread_id, promoteDateStr);

  // Update status
  db.prepare("UPDATE trials SET status = 'promoted' WHERE id = ?").run(trialId);

  // Send message to thread with green indicator
  try {
    const guild = client.guilds.cache.first();
    if (!guild) return;

    const thread = (await guild.channels.fetch(trial.thread_id)) as TextChannel | null;
    if (!thread) return;

    await thread.send(
      `**Marked for Promotion**\n` +
      `**${trial.character_name}** has been marked for promotion.\n` +
      `A promotion reminder will be sent on **${promoteDateStr}**.`,
    );
  } catch (error) {
    logger.warn(
      'Trials',
      `Failed to send promotion message for trial #${trialId}: ${error}`,
    );
  }

  logger.info(
    'Trials',
    `Marked trial #${trialId} (${trial.character_name}) for promotion on ${promoteDateStr}`,
  );
}

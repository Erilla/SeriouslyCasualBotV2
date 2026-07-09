import type { Client, AnyThreadChannel } from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';
import { config } from '../../config.js';
import { schedulePromoteAlert } from './scheduleTrialAlerts.js';
import { closeThread } from '../threads.js';
import { applyTrialTag } from './trialForumTags.js';
import type { TrialRow, PromoteAlertRow } from '../../types/index.js';

/**
 * Mark a trial for promotion. Schedules a promote alert for the next day.
 */
export async function markForPromotion(client: Client, trialId: number): Promise<void> {
  const db = getDatabase();

  const trial = db.prepare('SELECT * FROM trials WHERE id = ?').get(trialId) as
    | TrialRow
    | undefined;

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
    const guild = client.guilds.cache.get(config.guildId);
    if (!guild) return;

    const thread = (await guild.channels.fetch(trial.thread_id)) as AnyThreadChannel | null;
    if (!thread?.isThread()) return;

    await thread.send(
      `**Marked for Promotion**\n` +
        `**${trial.character_name}** has been marked for promotion.\n` +
        `A promotion reminder will be sent on **${promoteDateStr}**.`,
    );

    // Update the forum tag while the thread is un-archived (the send above
    // un-archives it), before closeThread locks/archives it again.
    await applyTrialTag(thread, 'To Be Promoted');

    // Close the thread (lock + archive). The next-day promotion reminder posts
    // back into the thread, which will auto-unarchive it; it stays locked.
    await closeThread(thread);
  } catch (error) {
    logger.warn('Trials', `Failed to send promotion message for trial #${trialId}: ${error}`);
  }

  logger.info(
    'Trials',
    `Marked trial #${trialId} (${trial.character_name}) for promotion on ${promoteDateStr}`,
  );
}

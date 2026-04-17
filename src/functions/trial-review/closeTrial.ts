import type { Client, ThreadChannel } from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';
import type { TrialRow, TrialAlertRow } from '../../types/index.js';

/**
 * Close a trial: set status to 'closed', archive the thread, clear pending alerts.
 */
export async function closeTrial(client: Client, trialId: number): Promise<void> {
  const db = getDatabase();

  const trial = db
    .prepare('SELECT * FROM trials WHERE id = ?')
    .get(trialId) as TrialRow | undefined;

  if (!trial) throw new Error(`Trial #${trialId} not found`);

  // Update status
  db.prepare("UPDATE trials SET status = 'closed' WHERE id = ?").run(trialId);

  // Mark all pending alerts as alerted (so they won't fire)
  db.prepare(
    'UPDATE trial_alerts SET alerted = 1 WHERE trial_id = ? AND alerted = 0',
  ).run(trialId);

  // Delete any promote alerts
  db.prepare('DELETE FROM promote_alerts WHERE trial_id = ?').run(trialId);

  // Archive the thread
  if (trial.thread_id) {
    try {
      const guild = client.guilds.cache.first();
      if (!guild) return;

      const thread = (await guild.channels.fetch(trial.thread_id)) as ThreadChannel | null;
      if (thread?.isThread()) {
        await thread.send(
          `**Trial Closed**\nThe trial for **${trial.character_name}** has been closed.`,
        );
        await thread.setArchived(true);
      }
    } catch (error) {
      logger.warn(
        'Trials',
        `Failed to archive thread for trial #${trialId}: ${error}`,
      );
    }
  }

  logger.info(
    'Trials',
    `Closed trial #${trialId} (${trial.character_name})`,
  );
}

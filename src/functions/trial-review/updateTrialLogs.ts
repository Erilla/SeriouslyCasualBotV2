import type { Client, TextChannel } from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';
import { generateTrialLogsContent } from './generateTrialLogs.js';
import type { TrialRow } from '../../types/index.js';

/**
 * Refresh WarcraftLogs attendance links for all active trials.
 */
export async function updateTrialLogs(client: Client): Promise<void> {
  const db = getDatabase();

  const trials = db
    .prepare("SELECT * FROM trials WHERE status = 'active'")
    .all() as TrialRow[];

  if (trials.length === 0) return;

  const guild = client.guilds.cache.first();
  if (!guild) {
    logger.warn('Trials', 'No guild found, cannot update trial logs');
    return;
  }

  let updated = 0;
  let failed = 0;

  for (const trial of trials) {
    if (!trial.thread_id) continue;

    try {
      const thread = (await guild.channels.fetch(trial.thread_id)) as TextChannel | null;
      if (!thread) {
        logger.debug('Trials', `Thread ${trial.thread_id} not found for trial #${trial.id}`);
        continue;
      }

      const logsContent = await generateTrialLogsContent(trial.character_name);
      if (!logsContent) continue;

      if (trial.logs_message_id) {
        // Try to edit existing message
        try {
          const existingMsg = await thread.messages.fetch(trial.logs_message_id);
          await existingMsg.edit(logsContent);
          updated++;
          continue;
        } catch {
          // Message may have been deleted - fall through to send new one
        }
      }

      // Send new message and store its ID
      const msg = await thread.send(logsContent);
      db.prepare('UPDATE trials SET logs_message_id = ? WHERE id = ?').run(
        msg.id,
        trial.id,
      );
      updated++;
    } catch (error) {
      failed++;
      logger.warn(
        'Trials',
        `Failed to update logs for trial #${trial.id} (${trial.character_name}): ${error}`,
      );
    }
  }

  logger.info(
    'Trials',
    `Updated trial logs: ${updated} updated, ${failed} failed out of ${trials.length} active trials`,
  );
}

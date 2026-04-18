import type { ThreadChannel } from 'discord.js';
import { getDatabase } from '../database/db.js';
import { logger } from '../services/logger.js';
import type { ApplicationRow, TrialRow } from '../types/index.js';

export default {
  name: 'threadUpdate',
  async execute(...args: unknown[]) {
    const oldThread = args[0] as ThreadChannel;
    const newThread = args[1] as ThreadChannel;

    // Only care about threads that just got archived
    if (!newThread.archived || oldThread.archived) return;

    const db = getDatabase();

    // Check if this thread belongs to an active trial
    const trial = db
      .prepare("SELECT * FROM trials WHERE thread_id = ? AND status IN ('active', 'promoted')")
      .get(newThread.id) as TrialRow | undefined;

    if (trial) {
      // Unarchive the trial thread
      try {
        await newThread.setArchived(false);
        logger.info(
          'Trials',
          `Unarchived trial thread for "${trial.character_name}" (#${trial.id})`,
        );
      } catch (error) {
        logger.error(
          'Trials',
          `Failed to unarchive trial thread ${newThread.id}: ${error}`,
          error as Error,
        );
      }
      return;
    }

    // Check if this thread belongs to an active application
    const application = db
      .prepare(
        "SELECT * FROM applications WHERE (forum_post_id = ? OR thread_id = ?) AND status IN ('in_progress', 'submitted', 'active')",
      )
      .get(newThread.id, newThread.id) as ApplicationRow | undefined;

    if (!application) return;

    // Unarchive the application thread
    try {
      await newThread.setArchived(false);
      logger.info(
        'Applications',
        `Unarchived application thread for "${application.character_name}" (#${application.id})`,
      );
    } catch (error) {
      logger.error(
        'Applications',
        `Failed to unarchive application thread ${newThread.id}: ${error}`,
        error as Error,
      );
    }
  },
};

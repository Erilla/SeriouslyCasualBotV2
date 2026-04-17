import type { ThreadChannel } from 'discord.js';
import { getDatabase } from '../database/db.js';
import { logger } from '../services/logger.js';
import type { TrialRow } from '../types/index.js';

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

    if (!trial) return;

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
  },
};

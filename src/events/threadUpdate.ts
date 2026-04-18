import type { ThreadChannel } from 'discord.js';
import { getDatabase } from '../database/db.js';
import { logger } from '../services/logger.js';
import type { ApplicationRow, TrialRow } from '../types/index.js';

async function tryUnarchive(thread: ThreadChannel, domain: string, name: string, id: number): Promise<void> {
  try {
    await thread.setArchived(false);
    logger.info(domain, `Unarchived thread for "${name}" (#${id})`);
  } catch (error) {
    logger.error(domain, `Failed to unarchive thread ${thread.id}: ${error}`, error as Error);
  }
}

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
      await tryUnarchive(newThread, 'Trials', trial.character_name, trial.id);
      return;
    }

    // Check if this thread belongs to an active application
    const application = db
      .prepare(
        "SELECT * FROM applications WHERE (forum_post_id = ? OR thread_id = ?) AND status IN ('in_progress', 'submitted', 'active')",
      )
      .get(newThread.id, newThread.id) as ApplicationRow | undefined;

    if (application) {
      await tryUnarchive(newThread, 'Applications', application.character_name ?? 'unknown', application.id);
    }
  },
};

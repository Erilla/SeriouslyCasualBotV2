import type { Client } from 'discord.js';
import { syncRaiders } from '../raids/syncRaiders.js';
import { alertForNewUnlinkedRaiders } from '../raids/alertForNewUnlinkedRaiders.js';
import { refreshLinkingMessages } from '../raids/refreshLinkingMessages.js';
import { updateTrialLogs } from '../trial-review/updateTrialLogs.js';
import { logger } from '../../services/logger.js';
import { recordTaskRun } from '../../services/statusTracker.js';

async function runTask(name: string, handler: () => Promise<void>): Promise<void> {
  try {
    await handler();
    recordTaskRun(name, true);
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    recordTaskRun(name, false, String(error));
    logger.error('DailyMaintenance', `Failed ${name}: ${err.message}`, err);
  }
}

export async function runDailyMaintenance(client: Client): Promise<void> {
  await runTask('syncRaiders', async () => {
    const newUnlinked = await syncRaiders(client);
    await alertForNewUnlinkedRaiders(client, newUnlinked);
  });
  await runTask('refreshLinkingMessages', () => refreshLinkingMessages(client));
  await runTask('updateTrialLogs', () => updateTrialLogs(client));
}

import type { Client } from 'discord.js';
import { logger } from '../services/logger.js';
import { Scheduler } from '../scheduler/scheduler.js';
import { deployCommands } from '../deploy-commands.js';
import { syncRaiders } from '../functions/raids/syncRaiders.js';
import { alertSignups } from '../functions/raids/alertSignups.js';
import { alertHighestMythicPlusDone } from '../functions/raids/alertHighestMythicPlusDone.js';
import { refreshLinkingMessages } from '../functions/raids/refreshLinkingMessages.js';
import { updateAchievements } from '../functions/guild-info/updateAchievements.js';
import { rescheduleAllAlerts } from '../functions/trial-review/scheduleTrialAlerts.js';
import { updateTrialLogs } from '../functions/trial-review/updateTrialLogs.js';

export const scheduler = new Scheduler();

export default {
  name: 'ready',
  once: true,
  async execute(...args: unknown[]) {
    const client = args[0] as Client;
    logger.info('bot', `Logged in as ${client.user?.tag}`);

    try {
      await deployCommands();
      logger.info('bot', 'Commands registered');
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('bot', `Failed to register commands: ${err.message}`, err);
    }

    // Register scheduled tasks
    scheduler.registerInterval({
      name: 'syncRaiders',
      intervalMs: 600_000,
      handler: () => syncRaiders(client),
    });

    scheduler.registerInterval({
      name: 'refreshLinkingMessages',
      intervalMs: 600_000,
      handler: () => refreshLinkingMessages(client),
    });

    scheduler.registerCron({
      name: 'alertSignups',
      expression: '0 19 * * 1,2,5,6',
      handler: () => alertSignups(client),
    });

    scheduler.registerCron({
      name: 'weeklyReports',
      expression: '0 12 * * 3',
      handler: () => alertHighestMythicPlusDone(client),
    });

    scheduler.registerInterval({
      name: 'updateAchievements',
      intervalMs: 1_800_000,
      handler: () => updateAchievements(client),
    });

    scheduler.registerInterval({
      name: 'updateTrialLogs',
      intervalMs: 3_600_000,
      handler: () => updateTrialLogs(client),
    });

    scheduler.start();

    // Reschedule trial alerts from DB (must happen after scheduler.start)
    rescheduleAllAlerts(client);

    logger.info('bot', 'Startup complete');
  },
};

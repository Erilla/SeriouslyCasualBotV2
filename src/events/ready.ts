import type { Client } from 'discord.js';
import { logger } from '../services/logger.js';
import { Scheduler } from '../scheduler/scheduler.js';
import { deployCommands } from '../deploy-commands.js';

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

    // Scheduled tasks will be registered by domain slices
    scheduler.start();

    logger.info('bot', 'Startup complete');
  },
};

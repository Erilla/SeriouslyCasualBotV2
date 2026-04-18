import { ChannelType, type Client } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../services/logger.js';
import { getOrCreateChannel } from '../functions/channels.js';
import { setAuditChannel } from '../services/auditLog.js';
import { Scheduler } from '../scheduler/scheduler.js';
import { deployCommands } from '../deploy-commands.js';
import { syncRaiders } from '../functions/raids/syncRaiders.js';
import { alertSignups } from '../functions/raids/alertSignups.js';
import { alertHighestMythicPlusDone } from '../functions/raids/alertHighestMythicPlusDone.js';
import { refreshLinkingMessages } from '../functions/raids/refreshLinkingMessages.js';
import { updateAchievements } from '../functions/guild-info/updateAchievements.js';
import { rescheduleAllAlerts } from '../functions/trial-review/scheduleTrialAlerts.js';
import { updateTrialLogs } from '../functions/trial-review/updateTrialLogs.js';
import { resumeSessions } from '../functions/applications/resumeSessions.js';
import { dailyBackup } from '../functions/backups/dailyBackup.js';
import { recordTaskRun } from '../services/statusTracker.js';

export const scheduler = new Scheduler();

export default {
  name: 'clientReady',
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

    const guild = await client.guilds.fetch(config.guildId).catch((err) => {
      logger.error(
        'bot',
        `Could not fetch guild for channel bootstrap: ${String(err)}`,
        err instanceof Error ? err : new Error(String(err)),
      );
      return null;
    });

    if (guild) {
      try {
        const botLogsChannel = await getOrCreateChannel(guild, {
          name: 'bot-logs',
          type: ChannelType.GuildText,
          categoryName: 'SeriouslyCasual Bot',
          configKey: 'bot_logs_channel_id',
        });
        logger.setDiscordChannel(botLogsChannel);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error('bot', `Channel bootstrap failed for bot-logs: ${err.message}`, err);
      }

      try {
        const botAuditChannel = await getOrCreateChannel(guild, {
          name: 'bot-audit',
          type: ChannelType.GuildText,
          categoryName: 'SeriouslyCasual Bot',
          configKey: 'bot_audit_channel_id',
        });
        setAuditChannel(botAuditChannel);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error('bot', `Channel bootstrap failed for bot-audit: ${err.message}`, err);
      }

      try {
        // Pre-resolve/cache the epgp-rankings channel ID; createDisplayPost reads it from config on demand.
        await getOrCreateChannel(guild, {
          name: 'epgp-rankings',
          type: ChannelType.GuildText,
          categoryName: 'Raiders',
          configKey: 'epgp_rankings_channel_id',
        });
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error('bot', `Channel bootstrap failed for epgp-rankings: ${err.message}`, err);
      }

      logger.info('bot', 'Channel bootstrap complete');
    }

    // Register scheduled tasks
    scheduler.registerInterval({
      name: 'syncRaiders',
      intervalMs: 600_000,
      handler: async () => {
        try {
          await syncRaiders(client);
          recordTaskRun('syncRaiders', true);
        } catch (error) {
          recordTaskRun('syncRaiders', false, String(error));
          throw error;
        }
      },
    });

    scheduler.registerInterval({
      name: 'refreshLinkingMessages',
      intervalMs: 600_000,
      handler: async () => {
        try {
          await refreshLinkingMessages(client);
          recordTaskRun('refreshLinkingMessages', true);
        } catch (error) {
          recordTaskRun('refreshLinkingMessages', false, String(error));
          throw error;
        }
      },
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
      handler: async () => {
        try {
          await updateAchievements(client);
          recordTaskRun('updateAchievements', true);
        } catch (error) {
          recordTaskRun('updateAchievements', false, String(error));
          throw error;
        }
      },
    });

    scheduler.registerInterval({
      name: 'updateTrialLogs',
      intervalMs: 3_600_000,
      handler: async () => {
        try {
          await updateTrialLogs(client);
          recordTaskRun('updateTrialLogs', true);
        } catch (error) {
          recordTaskRun('updateTrialLogs', false, String(error));
          throw error;
        }
      },
    });

    scheduler.registerCron({
      name: 'dailyBackup',
      expression: '0 4 * * *',
      handler: () => dailyBackup(),
    });

    scheduler.start();

    // Reschedule trial alerts from DB (must happen after scheduler.start)
    rescheduleAllAlerts(client);

    // Resume any in-progress DM application sessions from before restart
    await resumeSessions(client);

    logger.info('bot', 'Startup complete');
  },
};

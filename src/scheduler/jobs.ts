import { registerJob, scheduleRepeating } from './scheduler.js';
import { logger } from '../services/logger.js';
import { updateAchievements } from '../functions/guild-info/updateAchievements.js';
import { syncRaiders } from '../functions/raids/syncRaiders.js';
import { alertHighestMythicPlusDone } from '../functions/raids/alertHighestMythicPlusDone.js';
import { checkApplicationsLegacy } from '../functions/applications/checkApplicationsLegacy.js';
import { keepAppThreadsAlive } from '../functions/applications/keepAppThreadsAlive.js';

/**
 * Register all job handlers and schedule them.
 * Job handlers are stubs for now - they'll be implemented in later tasks.
 */
export async function registerAllJobs(): Promise<void> {
    // --- Interval Jobs ---

    // Task 5: Check for new applications (legacy mode) - every 5 min
    registerJob('checkApplications', async (client) => {
        await checkApplicationsLegacy(client);
    });

    // Task 5: Keep application threads alive - every 3 min
    registerJob('keepAppThreadsAlive', async (client) => {
        await keepAppThreadsAlive(client);
    });

    // Task 3: Update achievements - every 30 min
    registerJob('updateAchievements', async (client) => {
        await updateAchievements(client);
    });

    // Task 7: Update trial logs - every 60 min
    registerJob('updateTrialLogs', async (_client) => {
        // TODO: Implement in Task 7
        await logger.debug('[Job] updateTrialLogs - not yet implemented');
    });

    // Task 7: Keep trial threads alive - every 6 min
    registerJob('keepTrialThreadsAlive', async (_client) => {
        // TODO: Implement in Task 7
        await logger.debug('[Job] keepTrialThreadsAlive - not yet implemented');
    });

    // Task 7: Check for trial review alerts - every 3 min
    registerJob('checkReviewAlerts', async (_client) => {
        // TODO: Implement in Task 7
        await logger.debug('[Job] checkReviewAlerts - not yet implemented');
    });

    // Task 7: Check for promotion alerts - every 5 min
    registerJob('checkPromotionAlerts', async (_client) => {
        // TODO: Implement in Task 7
        await logger.debug('[Job] checkPromotionAlerts - not yet implemented');
    });

    // Task 4: Sync raiders from Raider.io - every 10 min
    registerJob('syncRaiders', async (client) => {
        await syncRaiders(client);
    });

    // --- Cron Jobs ---

    // Task 8: Alert signups - 7pm Mon/Tue/Fri/Sat
    registerJob('alertSignups', async (_client) => {
        // TODO: Implement in Task 8
        await logger.debug('[Job] alertSignups - not yet implemented');
    });

    // Task 4: Weekly M+/vault reports - noon Wednesday
    registerJob('weeklyReports', async (client) => {
        await alertHighestMythicPlusDone(client);
    });

    // Task 10: Update EPGP priority post - every 10 min
    registerJob('updatePriorityPost', async (_client) => {
        // TODO: Implement in Task 10
        await logger.debug('[Job] updatePriorityPost - not yet implemented');
    });

    // --- Schedule all jobs ---

    // Intervals (using 'every' in ms)
    await scheduleRepeating('checkApplications', '', { every: 5 * 60 * 1000 });
    await scheduleRepeating('keepAppThreadsAlive', '', { every: 3 * 60 * 1000 });
    await scheduleRepeating('updateAchievements', '', { every: 30 * 60 * 1000 });
    await scheduleRepeating('updateTrialLogs', '', { every: 60 * 60 * 1000 });
    await scheduleRepeating('keepTrialThreadsAlive', '', { every: 6 * 60 * 1000 });
    await scheduleRepeating('checkReviewAlerts', '', { every: 3 * 60 * 1000 });
    await scheduleRepeating('checkPromotionAlerts', '', { every: 5 * 60 * 1000 });
    await scheduleRepeating('syncRaiders', '', { every: 10 * 60 * 1000 });

    // Cron schedules (UTC)
    // 7pm Mon/Tue/Fri/Sat (UK time ~= 19:00 UTC, adjust if needed)
    await scheduleRepeating('alertSignups', '0 19 * * 1,2,5,6');

    // Noon Wednesday (UK time ~= 12:00 UTC)
    await scheduleRepeating('weeklyReports', '0 12 * * 3');

    // Every 10 minutes
    await scheduleRepeating('updatePriorityPost', '*/10 * * * *');

    await logger.info(`[Scheduler] Registered ${11} jobs`);
}

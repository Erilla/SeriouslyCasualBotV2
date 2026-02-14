import { Queue, Worker, type Job, type ConnectionOptions } from 'bullmq';
import { config } from '../config.js';
import { logger } from '../services/logger.js';
import type { BotClient } from '../types/index.js';

export type JobHandler = (client: BotClient) => Promise<void>;

let queue: Queue | null = null;
let worker: Worker | null = null;

const jobHandlers = new Map<string, JobHandler>();

function getConnectionOpts(): ConnectionOptions {
    // Parse Redis URL into host/port/password for BullMQ compatibility
    const url = new URL(config.redisUrl);
    return {
        host: url.hostname,
        port: parseInt(url.port || '6379', 10),
        password: url.password || undefined,
        maxRetriesPerRequest: null,
    };
}

/**
 * Register a job handler. Call this before initScheduler().
 */
export function registerJob(name: string, handler: JobHandler): void {
    jobHandlers.set(name, handler);
}

/**
 * Initialize the BullMQ scheduler with Redis connection.
 * Sets up the queue, worker, and schedules all repeatable jobs.
 */
export async function initScheduler(client: BotClient): Promise<void> {
    const connection = getConnectionOpts();

    queue = new Queue('bot-jobs', { connection });

    worker = new Worker(
        'bot-jobs',
        async (job: Job) => {
            const handler = jobHandlers.get(job.name);
            if (!handler) {
                await logger.warn(`[Scheduler] No handler for job: ${job.name}`);
                return;
            }

            try {
                await Promise.race([
                    handler(client),
                    new Promise<never>((_, reject) =>
                        setTimeout(() => reject(new Error(`Job ${job.name} timed out after 90s`)), 90_000),
                    ),
                ]);
            } catch (error) {
                await logger.error(`[Scheduler] Job ${job.name} failed`, error);
                throw error;
            }
        },
        { connection, concurrency: 1, lockDuration: 120_000 }
    );

    worker.on('failed', (job, err) => {
        logger.error(`[Scheduler] Job ${job?.name} failed: ${err.message}`, err).catch(() => {});
    });

    await logger.info('[Scheduler] BullMQ scheduler initialized');
}

/**
 * Schedule a repeatable job. Safe to call multiple times - BullMQ deduplicates by name+pattern.
 */
export async function scheduleRepeating(
    name: string,
    pattern: string,
    options?: { every?: number }
): Promise<void> {
    if (!queue) throw new Error('Scheduler not initialized');

    if (options?.every) {
        await queue.add(name, {}, {
            repeat: { every: options.every },
            removeOnComplete: { count: 5 },
            removeOnFail: { count: 10 },
        });
    } else {
        await queue.add(name, {}, {
            repeat: { pattern },
            removeOnComplete: { count: 5 },
            removeOnFail: { count: 10 },
        });
    }
}

/**
 * Get the queue instance for direct job management.
 */
export function getQueue(): Queue | null {
    return queue;
}

/**
 * Gracefully shut down the scheduler.
 */
export async function closeScheduler(): Promise<void> {
    if (worker) {
        await worker.close();
        worker = null;
    }
    if (queue) {
        await queue.close();
        queue = null;
    }
    console.log('[Scheduler] Scheduler shut down');
}

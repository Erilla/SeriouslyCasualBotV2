import cron from 'node-cron';
import { logger } from '../services/logger.js';

interface IntervalTask {
  name: string;
  intervalMs: number;
  handler: () => Promise<void>;
}

interface CronTask {
  name: string;
  expression: string;
  handler: () => Promise<void>;
}

export class Scheduler {
  private intervals: NodeJS.Timeout[] = [];
  private cronJobs: cron.ScheduledTask[] = [];
  private running: Map<string, boolean> = new Map();

  registerInterval(task: IntervalTask): void {
    const interval = setInterval(async () => {
      if (this.running.get(task.name)) {
        logger.debug('scheduler', `Skipping ${task.name} - still running`);
        return;
      }

      this.running.set(task.name, true);
      const start = Date.now();

      try {
        logger.debug('scheduler', `Running ${task.name}`);
        await task.handler();
        logger.debug('scheduler', `Completed ${task.name} in ${Date.now() - start}ms`);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error('scheduler', `Failed ${task.name}: ${err.message}`, err);
      } finally {
        this.running.set(task.name, false);
      }
    }, task.intervalMs);

    this.intervals.push(interval);
  }

  registerCron(task: CronTask): void {
    const job = cron.schedule(task.expression, async () => {
      if (this.running.get(task.name)) {
        logger.debug('scheduler', `Skipping cron ${task.name} - still running`);
        return;
      }

      this.running.set(task.name, true);
      const start = Date.now();

      try {
        logger.debug('scheduler', `Running cron ${task.name}`);
        await task.handler();
        logger.debug('scheduler', `Completed cron ${task.name} in ${Date.now() - start}ms`);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error('scheduler', `Failed cron ${task.name}: ${err.message}`, err);
      } finally {
        this.running.set(task.name, false);
      }
    });

    this.cronJobs.push(job);
  }

  start(): void {
    logger.info('scheduler', `Started with ${this.intervals.length} intervals and ${this.cronJobs.length} cron jobs`);
  }

  shutdown(): void {
    for (const interval of this.intervals) {
      clearInterval(interval);
    }
    for (const job of this.cronJobs) {
      job.stop();
    }
    this.intervals = [];
    this.cronJobs = [];
    this.running.clear();
    logger.info('scheduler', 'Shut down all tasks');
  }
}

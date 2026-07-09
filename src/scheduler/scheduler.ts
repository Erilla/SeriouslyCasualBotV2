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
  private intervalTimers: Map<string, NodeJS.Timeout> = new Map();
  private cronJobs: cron.ScheduledTask[] = [];
  private running: Map<string, boolean> = new Map();
  private stopped = false;

  registerInterval(task: IntervalTask): void {
    const runTick = async () => {
      // Chain the next aligned tick up front so the cadence stays pinned to the
      // wall clock regardless of how long this handler runs (a long run just
      // skips the boundaries it overruns, see the running-guard below).
      this.scheduleAlignedTick(task, runTick);

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
    };

    this.scheduleAlignedTick(task, runTick);
  }

  /**
   * Schedule the next run on a wall-clock boundary instead of relative to bot
   * start: a 10-minute task fires at :00, :10, :20 … A self-correcting setTimeout
   * (rather than setInterval) keeps it aligned even after timer drift or a slow
   * tick. Delay is in (0, intervalMs]; landing exactly on a boundary waits a full
   * interval rather than firing twice.
   */
  private scheduleAlignedTick(task: IntervalTask, runTick: () => void): void {
    if (this.stopped) return;
    const delay = task.intervalMs - (Date.now() % task.intervalMs);
    this.intervalTimers.set(task.name, setTimeout(runTick, delay));
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
    this.stopped = false;
    logger.info(
      'scheduler',
      `Started with ${this.intervalTimers.size} intervals and ${this.cronJobs.length} cron jobs`,
    );
  }

  shutdown(): void {
    this.stopped = true;
    for (const timer of this.intervalTimers.values()) {
      clearTimeout(timer);
    }
    for (const job of this.cronJobs) {
      job.stop();
    }
    this.intervalTimers.clear();
    this.cronJobs = [];
    this.running.clear();
    logger.info('scheduler', 'Shut down all tasks');
  }
}

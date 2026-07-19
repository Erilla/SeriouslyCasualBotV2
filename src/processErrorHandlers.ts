import { logger } from './services/logger.js';

/** Minimal surface of `process` used for registering error handlers (injectable for tests). */
export interface ProcessLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

/**
 * Register last-resort handlers for otherwise-fatal errors.
 *
 * The bot leans heavily on fire-and-forget promises; without these handlers an
 * escaped rejection or throw terminates the process silently with no log line.
 * We log (rather than exit) to match the codebase's resilient, best-effort
 * philosophy and to avoid restart loops — the diagnostic reaches the logs and,
 * via the logger's Discord relay, the bot-logs channel.
 */
export function registerProcessErrorHandlers(proc: ProcessLike = process): void {
  proc.on('unhandledRejection', (reason: unknown) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logger.error('process', `Unhandled promise rejection: ${err.message}`, err);
  });

  proc.on('uncaughtException', (error: unknown) => {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('process', `Uncaught exception: ${err.message}`, err);
  });
}

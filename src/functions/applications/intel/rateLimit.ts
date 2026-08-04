import { HttpError, CircuitOpenError, type ServiceName } from '../../../services/httpClient.js';

export interface PauseDecision {
  pause: boolean;
  service?: ServiceName;
  resumeAfterMs?: number;
}

/** 5min -> 15min -> 60min, capped. An hour is the natural window for both the
 *  Blizzard hourly request budget and the WarcraftLogs hourly points budget. */
const BACKOFF_STEPS_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000];

export function backoffMs(attempts: number): number {
  const index = Math.min(Math.max(attempts, 1), BACKOFF_STEPS_MS.length) - 1;
  return BACKOFF_STEPS_MS[index];
}

/**
 * Whether an error should pause the whole job (rate limiting) or merely fail
 * the current work item. Only 429s and an open circuit pause, so a permanently
 * broken item cannot stall the job forever.
 */
export function classifyError(error: unknown, attempts: number): PauseDecision {
  if (error instanceof CircuitOpenError) {
    return { pause: true, service: error.service, resumeAfterMs: backoffMs(attempts) };
  }
  if (error instanceof HttpError && error.status === 429) {
    return {
      pause: true,
      service: error.service,
      resumeAfterMs: error.retryAfterMs ?? backoffMs(attempts),
    };
  }
  return { pause: false };
}

export const WCL_POINTS_PREEMPT_RATIO = 0.9;

/**
 * WarcraftLogs bills by points, not requests, so a 429 is the last signal you
 * get. Every query asks for rateLimitData; pause at 90% of the hourly budget
 * rather than waiting to be refused.
 */
export function shouldPreemptWclPoints(pointsSpentThisHour: number, limitPerHour: number): boolean {
  if (!limitPerHour || limitPerHour <= 0) return false;
  return pointsSpentThisHour >= limitPerHour * WCL_POINTS_PREEMPT_RATIO;
}

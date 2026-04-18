import type { Client } from 'discord.js';
import { logger } from '../../../services/logger.js';
import { createTrialReviewThread } from '../../trial-review/createTrialReviewThread.js';

export interface SeedTrialDiscordOptions {
  characterName?: string;
  role?: string;
  applicationId?: number;
}

export interface SeedTrialDiscordResult {
  trialId: number | null;
  threadId: string | null;
  skippedReason?: string;
}

/**
 * Creates a trial via createTrialReviewThread, which handles DB insert, 3 trial_alerts,
 * forum thread creation, WarcraftLogs fetch, overlord invites, and alert scheduling.
 * The trial-reviews forum is auto-created if not configured.
 */
export async function seedTrialDiscord(
  client: Client,
  options: SeedTrialDiscordOptions = {},
): Promise<SeedTrialDiscordResult> {
  const characterName = options.characterName ?? 'Testcharacter';
  const role = options.role ?? 'DPS';

  const startDate = new Date();
  startDate.setUTCDate(startDate.getUTCDate() - 7);
  const startDateStr = startDate.toISOString().slice(0, 10);

  try {
    const trial = await createTrialReviewThread(client, {
      characterName,
      role,
      startDate: startDateStr,
      applicationId: options.applicationId,
    });
    return { trialId: trial.id, threadId: trial.thread_id ?? null };
  } catch (error) {
    logger.error('TestData', 'Failed to create trial review thread', error as Error);
    return {
      trialId: null,
      threadId: null,
      skippedReason: `trial thread failed: ${(error as Error).message}`,
    };
  }
}

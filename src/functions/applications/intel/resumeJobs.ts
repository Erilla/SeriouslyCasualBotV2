import type { Client, TextChannel } from 'discord.js';
import { logger } from '../../../services/logger.js';
import { dueJobs, resetRunningJobs } from './jobStore.js';
import { runJob } from './runJob.js';
import { getZoneCatalogue, getRaidReports } from '../../../services/warcraftlogs.js';
import { getMythicKillCount } from '../../../services/raiderio.js';
import {
  getMythicKillDates,
  RAIDERIO_INTERNAL_PACE_MS,
} from '../../../services/raiderioInternal.js';
import { discoverAlts } from '../alts/discoverAlts.js';
import { confirmDiscord } from '../alts/confirmDiscord.js';
import { gatherMythicLogs } from '../mythic-logs/gatherMythicLogs.js';
import { pruneCache } from '../../../services/apiCache.js';
import { FINGERPRINT_TTL_MS } from '../../../services/blizzard.js';

/** Raider.IO tier ordinals covering the last three expansions. Numeric and
 *  descending: 35 is the current tier, 28 reaches the oldest in the window. */
const TIER_ORDINALS = [35, 34, 33, 32, 31, 30, 29, 28];

async function editMessage(
  client: Client,
  channelId: string,
  messageId: string,
  description: string,
): Promise<void> {
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased()) return;
  const message = await (channel as TextChannel).messages.fetch(messageId);
  const embed = message.embeds[0];
  await message.edit({
    embeds: [{ ...embed?.toJSON(), description }],
  });
}

/** Scheduler tick: run every job that is pending or whose pause has elapsed. */
export async function resumeApplicantIntelJobs(
  client: Client,
  run?: (jobId: number) => Promise<void>,
): Promise<number> {
  const jobs = dueJobs(new Date().toISOString());
  let ran = 0;
  for (const job of jobs) {
    try {
      if (run) {
        await run(job.id);
      } else {
        await runJob(job.id, {
          editMessage: (channelId, messageId, description) =>
            editMessage(client, channelId, messageId, description),
          discover: discoverAlts,
          gather: gatherMythicLogs,
          confirm: confirmDiscord,
          getZoneCatalogue,
          getMythicKillCount,
          getRaidReports,
          getMythicKillDates,
          paceMs: RAIDERIO_INTERNAL_PACE_MS,
          tierOrdinals: TIER_ORDINALS,
        });
      }
      ran++;
    } catch (error) {
      // One bad job must not stop the rest of the queue.
      logger.error('Intel', `Job #${job.id} threw outside runJob: ${error}`, error as Error);
    }
  }
  return ran;
}

/** A job left 'running' by a crash cannot resume itself — same shape as
 *  resumeSessions for DM questionnaires. */
export function recoverInterruptedJobs(): number {
  const reset = resetRunningJobs();
  if (reset > 0) logger.info('Intel', `Reset ${reset} interrupted intel job(s) to pending`);

  // Fingerprints are ~85 KB each and a maxed sweep caches 3,000 of them, so
  // expired entries are dropped at boot rather than left to grow the volume.
  // Prefix-scoped: the achievements-image cache entries are FOREVER and must
  // survive. Once per start is enough — the TTL is a week.
  const pruned = pruneCache('fingerprint:', FINGERPRINT_TTL_MS);
  if (pruned > 0) logger.info('Intel', `Pruned ${pruned} expired fingerprint cache entries`);

  return reset;
}

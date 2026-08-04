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
import { cacheRowCount, pruneCache } from '../../../services/apiCache.js';
import { FINGERPRINT_TTL_MS } from '../../../services/blizzard.js';
import { buildPageButtons } from '../../pagination.js';
import type { PagingMeta } from './runJob.js';

/** Raider.IO tier ordinals covering the last three expansions. Numeric and
 *  descending: 35 is the current tier, 28 reaches the oldest in the window. */
const TIER_ORDINALS = [35, 34, 33, 32, 31, 30, 29, 28];

/**
 * The one legitimately Discord-bound half of publishing. runJob deliberately
 * imports no discord.js, so it passes paging METADATA and this function turns it
 * into the concrete `Page x/y` footer and the Previous/Next row — without which
 * the renderers' pages 2..N are unreachable and the reader gets no hint they
 * exist (guild history exceeds one page at roughly five guilds, i.e. routinely).
 *
 * `components: []` is always sent, so a row attached on an earlier edit is
 * cleared when a later render collapses back to a single page.
 *
 * Exported only so a unit test can pin the generated button ids against what
 * intelPagination's handlers actually parse; runJob reaches it via injection.
 */
export async function editIntelMessage(
  client: Client,
  channelId: string,
  messageId: string,
  description: string,
  paging?: PagingMeta,
): Promise<void> {
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased()) return;
  const message = await (channel as TextChannel).messages.fetch(messageId);
  const embed = message.embeds[0];

  const paged = paging && paging.totalPages > 1 ? paging : undefined;
  // The handlers parse `<prefix>:<jobId>:<page>`, which is NOT the shape
  // buildPageButtons builds by default (`page:<commandName>:<page>:<total>` —
  // that would be routed to the generic `page` cache handler instead), so the
  // id is supplied explicitly.
  const row = paged
    ? buildPageButtons(
        paged.prefix,
        paged.page,
        paged.totalPages,
        (target) => `${paged.prefix}:${paged.jobId}:${target}`,
      )
    : null;

  await message.edit({
    embeds: [
      {
        ...embed?.toJSON(),
        description,
        footer: paged ? { text: `Page ${paged.page}/${paged.totalPages}` } : undefined,
      },
    ],
    components: row ? [row] : [],
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
          editMessage: (channelId, messageId, description, paging) =>
            editIntelMessage(client, channelId, messageId, description, paging),
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

/**
 * Drop expired fingerprint cache entries, returning the number removed.
 *
 * Fingerprints are ~85 KB each and a maxed sweep caches 3,000 of them (~255 MB
 * per applicant), so this is the only thing keeping the Railway volume — shared
 * with the daily backups, which amplify it 8x — from filling up and failing
 * every SQLite write in the bot.
 *
 * Called at boot AND on the daily schedule, before the backup runs so the copy
 * is of the pruned database. Boot alone was not enough: a long-running container
 * never pruned the current window's growth at all.
 *
 * Prefix-scoped: the achievements-image cache entries are FOREVER and must
 * survive. Both counts are always logged so growth is observable in production.
 */
export function pruneFingerprintCache(): number {
  const pruned = pruneCache('fingerprint:', FINGERPRINT_TTL_MS);
  logger.info(
    'Intel',
    `Pruned ${pruned} expired fingerprint cache entries; api_cache now holds ${cacheRowCount()} rows`,
  );
  return pruned;
}

/** A job left 'running' by a crash cannot resume itself — same shape as
 *  resumeSessions for DM questionnaires. */
export function recoverInterruptedJobs(): number {
  const reset = resetRunningJobs();
  if (reset > 0) logger.info('Intel', `Reset ${reset} interrupted intel job(s) to pending`);

  pruneFingerprintCache();

  return reset;
}

import type { Client, TextChannel } from 'discord.js';
import { logger } from '../../../services/logger.js';
import type { IntelJobRow } from '../../../types/index.js';
import { getControlMessageId, getJob, type JobStatus } from './jobStore.js';
import { intelRefreshRow } from './placeholders.js';

/**
 * Redraw the officer Refresh control to match the job's current status.
 *
 * Purely a hint, so every failure is swallowed: the control's message is never
 * deleted, so Discord routes a click from a stale row anyway, and the handler
 * refuses it when a sweep is already in flight.
 *
 * Called either side of a run so the button reads "Refreshing…" while a sweep —
 * including a resumed one — is live, and from the click handler itself, so an
 * officer who clicks a stale row sees the button settle immediately rather than
 * at the next scheduler tick up to a minute later.
 *
 * Re-reads the status rather than trusting the row passed in: the caller's copy
 * may predate the very change this redraw exists to reflect.
 */
export async function syncRefreshControl(client: Client, job: IntelJobRow): Promise<void> {
  if (job.application_id === null || !job.target_channel_id) return;
  const messageId = getControlMessageId(job.id);
  if (!messageId) return;

  try {
    const channel = await client.channels.fetch(job.target_channel_id);
    if (!channel || !channel.isTextBased()) return;
    const message = await (channel as TextChannel).messages.fetch(messageId);
    const status = getJob(job.id)?.status ?? job.status;
    await message.edit({
      components: [intelRefreshRow(job.application_id, status as JobStatus)],
    });
  } catch (error) {
    logger.debug('Intel', `Job #${job.id}: could not redraw the refresh control: ${error}`);
  }
}

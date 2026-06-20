import type { GuildTextBasedChannel } from 'discord.js';

export interface ClearChannelResult {
  deleted: number;
  /** True if messages older than 14 days were present and had to be skipped. */
  skippedOld: boolean;
}

/**
 * Bulk-deletes messages from a channel in batches of 100 (Discord's bulk-delete
 * limit) until nothing deletable remains. Messages older than 14 days cannot be
 * bulk-deleted; `bulkDelete(…, true)` filters them out instead of throwing, and
 * we surface that via `skippedOld`.
 */
export async function clearChannel(channel: GuildTextBasedChannel): Promise<ClearChannelResult> {
  let deleted = 0;
  let skippedOld = false;

  for (;;) {
    const fetched = await channel.messages.fetch({ limit: 100 });
    if (fetched.size === 0) break;

    const removed = await channel.bulkDelete(fetched, true);
    deleted += removed.size;

    // Fewer removed than fetched means the remainder are >14 days old — every
    // older message sorts after these, so there's nothing left we can delete.
    if (removed.size < fetched.size) {
      skippedOld = true;
      break;
    }
  }

  return { deleted, skippedOld };
}

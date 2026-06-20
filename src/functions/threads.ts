import type { AnyThreadChannel } from 'discord.js';

/**
 * Close a forum post / thread: lock it (read-only) and archive it (out of the
 * active list) in a single atomic edit. Used when an application or trial is
 * resolved so the post doesn't linger in the active forum.
 *
 * Throws on failure (e.g. missing permissions) — callers wrap this in their
 * existing best-effort try/catch so a close failure only logs a warning and
 * never blocks the surrounding resolution (DM, channel cleanup, DB update).
 */
export async function closeThread(thread: AnyThreadChannel): Promise<void> {
  await thread.edit({ locked: true, archived: true });
}

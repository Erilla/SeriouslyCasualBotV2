import type { ThreadChannel } from 'discord.js';
import { getOverlordsList } from './raids/overlords.js';
import { logger } from '../services/logger.js';

/**
 * Add all overlords as members to a Discord thread.
 */
export async function addOverlordsToThread(thread: ThreadChannel): Promise<void> {
    const overlords = getOverlordsList();

    for (const overlord of overlords) {
        try {
            await thread.members.add(overlord.discord_user_id);
        } catch (error) {
            await logger.warn(`[Overlords] Failed to add ${overlord.name} to thread: ${error}`);
        }
    }
}

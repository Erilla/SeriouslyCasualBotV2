import { type Client, type ForumChannel, type ThreadChannel } from 'discord.js';
import { getChannel } from '../setup/getChannel.js';
import { getDatabase } from '../../database/database.js';
import { logger } from '../../services/logger.js';
import type { ApplicationRow } from '../../types/index.js';

/**
 * Keep active application forum threads alive by preventing auto-archive.
 * Unarchives any pending application threads that Discord has auto-archived.
 */
export async function keepAppThreadsAlive(client: Client): Promise<void> {
    const forumId = getChannel('applications_forum');
    if (!forumId) return;

    const db = getDatabase();
    const pendingApps = db
        .prepare("SELECT * FROM applications WHERE status = 'pending' AND forum_post_id IS NOT NULL")
        .all() as ApplicationRow[];

    if (pendingApps.length === 0) return;

    try {
        const forum = await client.channels.fetch(forumId) as ForumChannel | null;
        if (!forum) return;

        for (const app of pendingApps) {
            try {
                const thread = await forum.threads.fetch(app.forum_post_id!) as ThreadChannel | null;
                if (thread && thread.archived) {
                    await thread.setArchived(false);
                    await logger.debug(`[Applications] Unarchived thread for application ${app.id}`);
                }
            } catch {
                // Thread may have been deleted
            }
        }
    } catch (error) {
        await logger.error('[Applications] Error keeping threads alive', error);
    }
}

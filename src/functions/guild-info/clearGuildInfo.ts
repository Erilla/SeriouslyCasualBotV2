import type { Client, Collection, Message, TextChannel } from 'discord.js';
import { getDatabase } from '../../database/database.js';
import { logger } from '../../services/logger.js';
import { fetchTextChannel } from '../../utils.js';

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Delete all messages in the guild_info channel and clear stored message IDs.
 * Uses bulkDelete for recent messages (< 14 days) and individual delete for older ones.
 */
export async function clearGuildInfo(client: Client, channel?: TextChannel): Promise<void> {
    try {
        const textChannel = channel ?? await fetchTextChannel(client, 'guild_info');
        if (!textChannel) return;

        const messages = await textChannel.messages.fetch({ limit: 100 });
        if (messages.size > 0) {
            const now = Date.now();
            const recent: Collection<string, Message> = messages.filter(
                (m) => now - m.createdTimestamp < FOURTEEN_DAYS_MS,
            );
            const old = messages.filter(
                (m) => now - m.createdTimestamp >= FOURTEEN_DAYS_MS,
            );

            if (recent.size > 0) {
                await textChannel.bulkDelete(recent).catch(() => {});
            }
            for (const message of old.values()) {
                await message.delete().catch(() => {});
            }
        }

        // Clear stored message IDs
        const db = getDatabase();
        db.prepare('DELETE FROM guild_info').run();

        await logger.info(`[GuildInfo] Cleared ${messages.size} messages from guild info channel`);
    } catch (error) {
        await logger.error('[GuildInfo] Failed to clear guild info', error);
    }
}

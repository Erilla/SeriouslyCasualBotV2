import type { Client, TextChannel } from 'discord.js';
import { getChannel } from '../setup/getChannel.js';
import { getDatabase } from '../../database/database.js';
import { logger } from '../../services/logger.js';
import { asSendable } from '../../utils.js';

/**
 * Delete all messages in the guild_info channel and clear stored message IDs.
 */
export async function clearGuildInfo(client: Client): Promise<void> {
    const channelId = getChannel('guild_info');
    if (!channelId) {
        await logger.warn('[GuildInfo] guild_info channel not configured');
        return;
    }

    try {
        const channel = await client.channels.fetch(channelId);
        const sendable = asSendable(channel);
        if (!sendable) return;

        const textChannel = sendable as TextChannel;
        const messages = await textChannel.messages.fetch({ limit: 100 });

        for (const message of messages.values()) {
            await message.delete().catch(() => {});
        }

        // Clear stored message IDs
        const db = getDatabase();
        db.prepare('DELETE FROM guild_info').run();

        await logger.info(`[GuildInfo] Cleared ${messages.size} messages from guild info channel`);
    } catch (error) {
        await logger.error('[GuildInfo] Failed to clear guild info', error);
    }
}

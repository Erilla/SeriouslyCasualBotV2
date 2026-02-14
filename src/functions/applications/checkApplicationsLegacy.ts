import {
    type Client,
    type TextChannel,
    type CategoryChannel,
    ChannelType,
} from 'discord.js';
import { getChannel } from '../setup/getChannel.js';
import { getDatabase } from '../../database/database.js';
import { getBooleanSetting } from '../settings/getSetting.js';
import { copyApplicationToViewer } from './copyApplicationToViewer.js';
import { logger } from '../../services/logger.js';
import type { ApplicationRow } from '../../types/index.js';

/**
 * Check for new application channels in the applications category (legacy mode).
 * Scans the category for text channels not yet tracked in the applications table,
 * copies their content, and creates forum posts.
 */
export async function checkApplicationsLegacy(client: Client): Promise<void> {
    // Only run in legacy mode
    if (getBooleanSetting('use_custom_applications')) return;
    if (!getBooleanSetting('alert_applications')) return;

    const categoryId = getChannel('applications_category');
    if (!categoryId) return;

    try {
        const category = await client.channels.fetch(categoryId) as CategoryChannel | null;
        if (!category || category.type !== ChannelType.GuildCategory) {
            await logger.warn('[Applications] applications_category is not a category channel');
            return;
        }

        const db = getDatabase();

        // Get all text channels in the category
        const channels = category.children.cache.filter(
            (ch) => ch.type === ChannelType.GuildText,
        );

        for (const [, channel] of channels) {
            const textChannel = channel as TextChannel;

            // Check if we already have an application for this channel
            const existing = db
                .prepare('SELECT * FROM applications WHERE channel_id = ?')
                .get(textChannel.id) as ApplicationRow | undefined;

            if (existing) continue;

            // New application channel found
            await logger.info(`[Applications] Found new legacy application channel: #${textChannel.name}`);
            await copyApplicationToViewer(client, textChannel);
        }
    } catch (error) {
        await logger.error('[Applications] Error checking legacy applications', error);
    }
}

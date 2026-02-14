import {
    type Client,
    type TextChannel,
    ChannelType,
    PermissionFlagsBits,
} from 'discord.js';
import { config } from '../../config.js';
import { getChannel } from '../setup/getChannel.js';
import { buildApplicationEmbedBatches } from './buildApplicationEmbeds.js';
import { logger } from '../../services/logger.js';

/**
 * Create a private text channel for an applicant within the applications category.
 * The channel is visible to the applicant and server administrators only.
 * Returns the created channel, or null on failure.
 */
export async function createApplicationChannel(
    client: Client,
    applicantId: string,
    applicantName: string,
    questionsAndAnswers: Array<{ question: string; answer: string }>,
): Promise<TextChannel | null> {
    const categoryId = getChannel('applications_category');
    if (!categoryId) {
        await logger.warn('[Applications] applications_category not configured');
        return null;
    }

    const guild = client.guilds.cache.get(config.guildId);
    if (!guild) {
        await logger.warn(`[Applications] Guild ${config.guildId} not found in cache`);
        return null;
    }

    try {
        const channelName = `app-${applicantName.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;

        const channel = await guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            parent: categoryId,
            permissionOverwrites: [
                {
                    id: guild.id,
                    deny: [PermissionFlagsBits.ViewChannel],
                },
                {
                    id: applicantId,
                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.ReadMessageHistory,
                    ],
                },
            ],
        });

        // Post the application content in batches (respecting 6000 char per-message limit)
        const batches = buildApplicationEmbedBatches(
            `Application from ${applicantName}`,
            null,
            questionsAndAnswers,
        );
        for (const batch of batches) {
            await channel.send({ embeds: batch });
        }
        await channel.send(`Welcome <@${applicantId}>! An officer will review your application soon.`);

        await logger.info(`[Applications] Created application channel #${channelName} for ${applicantName}`);
        return channel;
    } catch (error) {
        await logger.error('[Applications] Failed to create application channel', error);
        return null;
    }
}

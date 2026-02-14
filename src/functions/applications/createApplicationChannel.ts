import {
    type Client,
    type TextChannel,
    ChannelType,
    PermissionFlagsBits,
    EmbedBuilder,
    Colors,
} from 'discord.js';
import { config } from '../../config.js';
import { getChannel } from '../setup/getChannel.js';
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

    const guild = client.guilds.cache.get(config.guildId) ?? client.guilds.cache.first();
    if (!guild) {
        await logger.warn('[Applications] No guild available');
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

        // Post the application content
        const embed = new EmbedBuilder()
            .setTitle(`Application from ${applicantName}`)
            .setColor(Colors.Blue)
            .setTimestamp();

        // Build description from Q&A pairs
        const parts = questionsAndAnswers.map(
            (qa, i) => `**Q${i + 1}: ${qa.question}**\n${qa.answer}`,
        );

        // Split into multiple embeds if needed (4096 char limit per embed description)
        const embeds: EmbedBuilder[] = [];
        let currentDescription = '';

        for (const part of parts) {
            if (currentDescription.length + part.length + 4 > 4000) {
                const e = new EmbedBuilder().setDescription(currentDescription).setColor(Colors.Blue);
                embeds.push(e);
                currentDescription = part;
            } else {
                currentDescription += (currentDescription ? '\n\n' : '') + part;
            }
        }

        if (currentDescription) {
            if (embeds.length === 0) {
                embed.setDescription(currentDescription);
                embeds.push(embed);
            } else {
                embeds.push(new EmbedBuilder().setDescription(currentDescription).setColor(Colors.Blue));
                // Set title on first embed
                embeds[0].setTitle(`Application from ${applicantName}`).setTimestamp();
            }
        } else {
            embeds.push(embed.setDescription('No answers provided.'));
        }

        await channel.send({ embeds });
        await channel.send(`Welcome <@${applicantId}>! An officer will review your application soon.`);

        await logger.info(`[Applications] Created application channel #${channelName} for ${applicantName}`);
        return channel;
    } catch (error) {
        await logger.error('[Applications] Failed to create application channel', error);
        return null;
    }
}

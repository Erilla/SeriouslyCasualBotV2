import {
    type Client,
    type ForumChannel,
    type ThreadChannel,
    ChannelType,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} from 'discord.js';
import { getChannel } from '../setup/getChannel.js';
import { getDatabase } from '../../database/database.js';
import { buildApplicationEmbedBatches } from './buildApplicationEmbeds.js';
import { logger } from '../../services/logger.js';

/** Forum tag names used by the application system */
const TAG_NAMES = {
    ACTIVE: 'Active',
    ACCEPTED: 'Accepted',
    REJECTED: 'Rejected',
} as const;

/**
 * Create a forum post in the applications forum with voting buttons.
 * Returns the created thread, or null on failure.
 */
export async function createForumPost(
    client: Client,
    applicantId: string,
    applicantName: string,
    questionsAndAnswers: Array<{ question: string; answer: string }>,
): Promise<ThreadChannel | null> {
    const forumId = getChannel('applications_forum');
    if (!forumId) {
        await logger.warn('[Applications] applications_forum not configured');
        return null;
    }

    try {
        const fetched = await client.channels.fetch(forumId);
        if (!fetched || fetched.type !== ChannelType.GuildForum) {
            await logger.warn(`[Applications] applications_forum (${forumId}) is not a forum channel`);
            return null;
        }
        const forum = fetched as ForumChannel;

        // Ensure forum tags exist
        await ensureForumTags(forum);

        // Find the Active tag
        const activeTag = forum.availableTags.find((t) => t.name === TAG_NAMES.ACTIVE);

        // Build application content embeds in batches (respecting 6000 char limit)
        const batches = buildApplicationEmbedBatches(
            `Application: ${applicantName}`,
            `<@${applicantId}>`,
            questionsAndAnswers,
        );

        // Build voting buttons
        const votingRow = buildVotingButtons();

        // Create the forum thread with first batch + voting buttons
        const thread = await forum.threads.create({
            name: `${applicantName}`,
            message: {
                embeds: batches[0] ?? [],
                components: [votingRow],
            },
            appliedTags: activeTag ? [activeTag.id] : [],
        });

        // Register the voting message in the DB immediately (buttons are already live)
        const db = getDatabase();
        db.prepare('INSERT INTO application_votes (forum_post_id) VALUES (?)').run(thread.id);

        // Send overflow batches as follow-up messages
        for (let i = 1; i < batches.length; i++) {
            await thread.send({ embeds: batches[i] });
        }

        await logger.info(`[Applications] Created forum post for ${applicantName}`);
        return thread;
    } catch (error) {
        await logger.error('[Applications] Failed to create forum post', error);
        return null;
    }
}

/**
 * Ensure the required forum tags exist on the applications forum.
 */
async function ensureForumTags(forum: ForumChannel): Promise<void> {
    const existingNames = new Set(forum.availableTags.map((t) => t.name));
    const needed = Object.values(TAG_NAMES).filter((name) => !existingNames.has(name));

    if (needed.length === 0) return;

    try {
        const newTags = [
            ...forum.availableTags,
            ...needed.map((name) => ({ name })),
        ];
        await forum.setAvailableTags(newTags);
        await logger.info(`[Applications] Created forum tags: ${needed.join(', ')}`);
    } catch (error) {
        await logger.warn(`[Applications] Failed to create forum tags: ${error}`);
    }
}

/**
 * Build the voting buttons row for application forum posts.
 */
export function buildVotingButtons(): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId('application_vote:for')
            .setLabel('For')
            .setStyle(ButtonStyle.Success)
            .setEmoji('👍'),
        new ButtonBuilder()
            .setCustomId('application_vote:neutral')
            .setLabel('Neutral')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('😐'),
        new ButtonBuilder()
            .setCustomId('application_vote:against')
            .setLabel('Against')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('👎'),
        new ButtonBuilder()
            .setCustomId('application_vote:kekw')
            .setLabel('Kekw')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('😂'),
    );
}

/**
 * Update a forum post's tag (e.g., from Active to Accepted/Rejected).
 */
export async function updateForumPostTag(
    client: Client,
    threadId: string,
    tagName: string,
): Promise<boolean> {
    const forumId = getChannel('applications_forum');
    if (!forumId) return false;

    try {
        const forum = await client.channels.fetch(forumId) as ForumChannel | null;
        if (!forum) return false;

        const thread = await forum.threads.fetch(threadId);
        if (!thread) return false;

        const tag = forum.availableTags.find((t) => t.name === tagName);
        if (!tag) return false;

        await thread.setAppliedTags([tag.id]);
        return true;
    } catch (error) {
        await logger.warn(`[Applications] Failed to update forum tag: ${error}`);
        return false;
    }
}

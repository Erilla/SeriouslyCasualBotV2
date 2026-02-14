import { type ButtonInteraction, EmbedBuilder, Colors, MessageFlags } from 'discord.js';
import { getDatabase } from '../../database/database.js';
import { buildVotingButtons } from './createForumPost.js';
import { logger } from '../../services/logger.js';
import type { ApplicationRow, VoteEntryRow } from '../../types/index.js';

const VOTE_LABELS: Record<string, string> = {
    for: 'For',
    neutral: 'Neutral',
    against: 'Against',
    kekw: 'Kekw',
};

const VOTE_EMOJIS: Record<string, string> = {
    for: '👍',
    neutral: '😐',
    against: '👎',
    kekw: '😂',
};

/**
 * Handle a vote on an application forum post.
 */
export async function voteOnApplication(
    interaction: ButtonInteraction,
    voteType: string,
): Promise<void> {
    if (!VOTE_LABELS[voteType]) {
        await interaction.reply({ content: 'Invalid vote type.', flags: MessageFlags.Ephemeral });
        return;
    }

    const forumPostId = interaction.channelId;
    const userId = interaction.user.id;
    const db = getDatabase();

    // Prevent applicants from voting on their own application
    const app = db
        .prepare('SELECT * FROM applications WHERE forum_post_id = ?')
        .get(forumPostId) as ApplicationRow | undefined;
    if (app && app.user_id === userId) {
        await interaction.reply({ content: 'You cannot vote on your own application.', flags: MessageFlags.Ephemeral });
        return;
    }

    // Ensure application_votes record exists + upsert vote atomically
    const upsertVote = db.transaction(() => {
        db.prepare('INSERT OR IGNORE INTO application_votes (forum_post_id) VALUES (?)').run(forumPostId);
        db.prepare(
            `INSERT INTO vote_entries (forum_post_id, user_id, vote_type)
             VALUES (?, ?, ?)
             ON CONFLICT(forum_post_id, user_id) DO UPDATE SET vote_type = excluded.vote_type`,
        ).run(forumPostId, userId, voteType);
    });
    upsertVote();

    // Get all votes for this post
    const votes = db
        .prepare('SELECT * FROM vote_entries WHERE forum_post_id = ?')
        .all(forumPostId) as VoteEntryRow[];

    // Build vote summary
    const voteCounts: Record<string, number> = { for: 0, neutral: 0, against: 0, kekw: 0 };
    const votersByType: Record<string, string[]> = { for: [], neutral: [], against: [], kekw: [] };

    for (const vote of votes) {
        if (voteCounts[vote.vote_type] !== undefined) {
            voteCounts[vote.vote_type]++;
            votersByType[vote.vote_type].push(`<@${vote.user_id}>`);
        }
    }

    const summaryLines = Object.entries(VOTE_LABELS).map(([key, label]) => {
        const emoji = VOTE_EMOJIS[key];
        const count = voteCounts[key];
        const voters = votersByType[key].join(', ') || '-';
        return `${emoji} **${label}** (${count}): ${voters}`;
    });

    const embed = new EmbedBuilder()
        .setTitle('Application Votes')
        .setDescription(summaryLines.join('\n'))
        .setColor(Colors.Blue)
        .setFooter({ text: `Total votes: ${votes.length}` })
        .setTimestamp();

    const votingRow = buildVotingButtons();

    // Keep application content embeds, replace the vote summary embed with updated one
    const existingEmbeds = interaction.message.embeds;
    const lastEmbed = existingEmbeds[existingEmbeds.length - 1];
    const lastIsVoteSummary = lastEmbed?.title === 'Application Votes';
    const contentEmbeds = lastIsVoteSummary ? existingEmbeds.slice(0, -1) : existingEmbeds;

    try {
        await interaction.update({
            embeds: [...contentEmbeds, embed],
            components: [votingRow],
        });
    } catch (error) {
        await logger.warn(`[Applications] Failed to update vote message: ${error}`);
    }

    await logger.debug(`[Applications] ${interaction.user.tag} voted ${voteType} on ${forumPostId}`);
}

import { type ButtonInteraction, EmbedBuilder, Colors, MessageFlags } from 'discord.js';
import { getDatabase } from '../../database/database.js';
import { buildVotingButtons } from './createForumPost.js';
import { logger } from '../../services/logger.js';
import type { VoteEntryRow } from '../../types/index.js';

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

    // Upsert vote
    db.prepare(
        `INSERT INTO vote_entries (forum_post_id, user_id, vote_type)
         VALUES (?, ?, ?)
         ON CONFLICT(forum_post_id, user_id) DO UPDATE SET vote_type = excluded.vote_type`,
    ).run(forumPostId, userId, voteType);

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

    try {
        await interaction.update({
            embeds: [...(interaction.message.embeds.slice(0, -1)), embed],
            components: [votingRow],
        });
    } catch {
        // If the original message has many embeds, just update with the vote embed
        await interaction.update({
            embeds: [embed],
            components: [votingRow],
        });
    }

    await logger.debug(`[Applications] ${interaction.user.tag} voted ${voteType} on ${forumPostId}`);
}

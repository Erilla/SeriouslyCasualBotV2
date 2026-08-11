import { EmbedBuilder, Colors, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';
import type { ApplicationVoteRow } from '../../types/index.js';

/**
 * Build the voting embed with a progress bar and voter names, plus vote buttons.
 */
export function generateVotingEmbed(applicationId: number): {
  embeds: [EmbedBuilder];
  components: [ActionRowBuilder<ButtonBuilder>];
} {
  const db = getDatabase();

  const votes = db
    .prepare('SELECT * FROM application_votes WHERE application_id = ?')
    .all(applicationId) as ApplicationVoteRow[];

  // Group by vote type. A type with no group is ignored rather than counted
  // anywhere — which is what retires a vote type safely: the button is gone, but
  // its message is never deleted, so a click on an old embed can still write a
  // row and this must keep rendering.
  const grouped: Record<string, ApplicationVoteRow[]> = {
    for: [],
    neutral: [],
    against: [],
  };

  for (const vote of votes) {
    if (grouped[vote.vote_type]) {
      grouped[vote.vote_type].push(vote);
    }
  }

  // One glyph per vote, rather than a proportional bar.
  //
  // The bar showed a RATIO, which on the handful of votes an application
  // actually gets was actively misleading: a lone "for" filled it completely,
  // reading as unanimous approval when one officer had voted. Glyphs show the
  // count itself, so three-of-four never looks like a landslide — and abstentions
  // become visible, where the bar could only ever ignore them.
  const forCount = grouped.for.length;
  const againstCount = grouped.against.length;
  const totalDecisive = forCount + againstCount;

  const marks =
    '✅'.repeat(forCount) + '➖'.repeat(grouped.neutral.length) + '❌'.repeat(againstCount);
  // Only a genuinely empty vote is "no votes yet". An application everyone
  // abstained on HAS been voted on, and the old ratio-only bar said otherwise.
  const progressBar =
    marks === ''
      ? 'No votes yet'
      : totalDecisive === 0
        ? marks
        : `${marks} ${forCount}/${totalDecisive}`;

  // Build fields
  const formatVoters = (voteList: ApplicationVoteRow[]): string =>
    voteList.length > 0 ? voteList.map((v) => `<@${v.user_id}>`).join(', ') : 'None';

  const embed = new EmbedBuilder()
    .setTitle('Application Vote')
    .setColor(Colors.Green)
    .addFields(
      {
        name: `For (${grouped.for.length})`,
        value: formatVoters(grouped.for),
        inline: true,
      },
      {
        name: `Neutral (${grouped.neutral.length})`,
        value: formatVoters(grouped.neutral),
        inline: true,
      },
      {
        name: `Against (${grouped.against.length})`,
        value: formatVoters(grouped.against),
        inline: true,
      },
      {
        name: 'Progress',
        value: progressBar,
        inline: false,
      },
    )
    .setTimestamp();

  const votingRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`application_vote:for:${applicationId}`)
      .setLabel('For')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`application_vote:neutral:${applicationId}`)
      .setLabel('Neutral')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`application_vote:against:${applicationId}`)
      .setLabel('Against')
      .setStyle(ButtonStyle.Danger),
  );

  logger.debug(
    'Applications',
    `Generated voting embed for application #${applicationId} (${votes.length} total votes)`,
  );

  return { embeds: [embed], components: [votingRow] };
}

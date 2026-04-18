import type { ButtonInteraction } from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';
import { generateVotingEmbed } from './generateVotingEmbed.js';

/**
 * Handle a vote button click: upsert the vote and refresh the embed.
 */
export async function voteOnApplication(
  interaction: ButtonInteraction,
  applicationId: number,
  voteType: string,
): Promise<void> {
  const db = getDatabase();

  // Upsert: one vote per user per application
  db.prepare(
    'INSERT OR REPLACE INTO application_votes (application_id, user_id, vote_type) VALUES (?, ?, ?)',
  ).run(applicationId, interaction.user.id, voteType);

  logger.info('Applications', `Vote recorded: user ${interaction.user.id} voted '${voteType}' on application #${applicationId}`);

  // Regenerate the embed and update the message in place
  const updated = generateVotingEmbed(applicationId);
  await interaction.update(updated);
}

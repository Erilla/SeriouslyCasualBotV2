import type { ButtonInteraction } from 'discord.js';
import { getDatabase } from '../../database/db.js';
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

  // Regenerate the embed and update the message in place
  const updated = generateVotingEmbed(applicationId);
  await interaction.update(updated);
}

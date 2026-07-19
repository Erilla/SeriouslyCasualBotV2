import type { MessageCreateOptions } from 'discord.js';

/**
 * Build the "new application" notification sent to overlords.
 *
 * The character name is applicant-supplied, so `allowedMentions` is locked to
 * the explicit overlord user ids: a crafted name like `@everyone` renders as
 * literal text and cannot trigger a real ping.
 */
export function buildOverlordNotification(
  overlordIds: string[],
  characterName: string,
  applicantTag: string,
): MessageCreateOptions {
  const mentions = overlordIds.map((id) => `<@${id}>`).join(' ');
  return {
    content: `${mentions}\nNew application from **${characterName}** (${applicantTag}). Please review!`,
    allowedMentions: { users: overlordIds },
  };
}

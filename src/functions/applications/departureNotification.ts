import type { MessageCreateOptions } from 'discord.js';

/** Title used for the audit-channel mirror of a departure. */
export const DEPARTURE_AUDIT_TITLE = 'Applicant left the server';

export interface DepartureFacts {
  /** applications.character_name — nullable, so the Discord tag is the fallback. */
  characterName: string | null;
  applicantTag: string;
  applicantUserId: string;
  applicationId: number;
}

/**
 * The character name if the application captured one, else the Discord tag — the
 * one identifier that always exists, and what an overlord would search for.
 */
function displayName(facts: DepartureFacts): string {
  return facts.characterName ?? facts.applicantTag;
}

/**
 * The applicant, mentioned and labelled as such. The mention is inert: it is
 * never listed in `allowedMentions`, and they have left the guild anyway. It
 * earns its place by rendering as their current display name rather than a tag
 * that may already be stale.
 */
function applicantReference(facts: DepartureFacts): string {
  return `<@${facts.applicantUserId}> (applicant)`;
}

/**
 * Build the "applicant left" notification for the application log post.
 *
 * Deliberately the same shape as `buildOverlordNotification`: one plain line in
 * the post overlords already watch, rather than an embed. Embeds in this bot
 * carry content (voting, intel, recruitment), and a red one reads as an error
 * rather than an event.
 *
 * `allowedMentions` is locked to the explicit overlord ids for the same reason
 * as the new-application notification: `character_name` is applicant-supplied,
 * so a crafted name like `@everyone` must render as literal text.
 */
export function buildDepartureNotification(
  overlordIds: string[],
  facts: DepartureFacts,
): MessageCreateOptions {
  const sentence =
    `**${displayName(facts)}** ${applicantReference(facts)} has left the server. ` +
    `Reject the application to close it off.`;
  // No overlords configured means no mention line at all — not a leading blank.
  const mentions = overlordIds.map((id) => `<@${id}>`).join(' ');

  return {
    content: mentions ? `${mentions}\n${sentence}` : sentence,
    allowedMentions: { users: overlordIds },
  };
}

/**
 * The audit-channel mirror's detail line. Same facts as the post, plus the raw
 * user id — useful for a ban or an audit-log search, and out of place in prose.
 */
export function buildDepartureAuditDetail(facts: DepartureFacts): string {
  return (
    `${displayName(facts)} ${applicantReference(facts)} — ` +
    `application #${facts.applicationId}, user id \`${facts.applicantUserId}\``
  );
}

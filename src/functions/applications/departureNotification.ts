import type { MessageCreateOptions } from 'discord.js';

/** Title used for the audit-channel mirror of an applicant departure. */
export const DEPARTURE_AUDIT_TITLE = 'Applicant left the server';
/** Its trial counterpart, so the two are distinguishable in the audit channel. */
export const TRIAL_DEPARTURE_AUDIT_TITLE = 'Trial left the server';

export interface DepartureFacts {
  /** How the leaver is labelled in the message: `(applicant)` or `(trial)`. */
  subject: 'applicant' | 'trial';
  /** `applications.character_name` is nullable, so the tag is the fallback. A
   *  trial's is NOT NULL, so for trials this is always set. */
  characterName: string | null;
  tag: string;
  userId: string;
  /** `application #12` / `trial #4`, for the audit detail. */
  reference: string;
  /** The closing instruction: how to close this thing off. */
  closingAction: string;
}

/**
 * The character name if there is one, else the Discord tag — the one identifier
 * that always exists, and what an overlord would search for.
 */
function displayName(facts: DepartureFacts): string {
  return facts.characterName ?? facts.tag;
}

/**
 * The leaver, mentioned and labelled. The mention is inert: it is never listed in
 * `allowedMentions`, and they have left the guild anyway. It earns its place by
 * rendering as their current display name rather than a tag that may already be
 * stale.
 */
function subjectReference(facts: DepartureFacts): string {
  return `<@${facts.userId}> (${facts.subject})`;
}

/**
 * Build the "X left" notification for the post overlords already watch.
 *
 * Deliberately the same shape as `buildOverlordNotification`: one plain line
 * rather than an embed. Embeds in this bot carry content (voting, intel,
 * recruitment), and a red one reads as an error rather than an event.
 *
 * `allowedMentions` is locked to the explicit overlord ids because the character
 * name is user-supplied, so a crafted name like `@everyone` must render as literal
 * text. This holds for both subjects: an applicant types their own name, and an
 * officer types a trial's.
 */
export function buildDepartureNotification(
  overlordIds: string[],
  facts: DepartureFacts,
): MessageCreateOptions {
  const sentence =
    `**${displayName(facts)}** ${subjectReference(facts)} has left the server. ` +
    facts.closingAction;
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
    `${displayName(facts)} ${subjectReference(facts)} — ` +
    `${facts.reference}, user id \`${facts.userId}\``
  );
}

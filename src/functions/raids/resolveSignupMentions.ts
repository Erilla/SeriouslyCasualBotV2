import type { Database } from 'better-sqlite3';

interface LinkRow {
  character_name: string;
  discord_user_id: string;
}

function lookupOf(rows: LinkRow[]): Map<string, string> {
  return new Map(rows.map((r) => [r.character_name.toLowerCase(), r.discord_user_id]));
}

/**
 * Turn unsigned character names into ping-able mentions, falling back to a bold
 * character name when nobody knows whose Discord account the character is.
 *
 * `raiders` is the primary source but it is gated behind the Raider.IO guild
 * roster, which is exactly wrong for a brand-new trial: they sign up in wowaudit
 * days before Raider.IO has crawled them, and a fresh guild invite sits at a rank
 * outside ROSTER_RANKS until an officer promotes them, so no row exists to mention
 * them by. Their Discord account is known all the same — from whoever the officer
 * picked when the trial was created (`trials`), or from their application
 * (`raider_identity_map`, the same map syncRaiders trusts to auto-link a raider).
 * Consulting those is what stops a trial being named as plain text next to
 * everyone else's ping.
 *
 * Order is most-authoritative first: an officer-confirmed roster link beats the
 * trial record, which beats the self-asserted application link. Inactive raiders
 * and non-active trials are ignored — a stale row must not out-rank a live one.
 */
export function resolveSignupMentions(db: Database, characterNames: string[]): string[] {
  const raiders = lookupOf(
    db
      .prepare(
        `SELECT character_name, discord_user_id FROM raiders
          WHERE discord_user_id IS NOT NULL AND inactive_since IS NULL`,
      )
      .all() as LinkRow[],
  );

  const trials = lookupOf(
    db
      .prepare(
        `SELECT character_name, discord_user_id FROM trials
          WHERE discord_user_id IS NOT NULL AND status = 'active'`,
      )
      .all() as LinkRow[],
  );

  const identities = lookupOf(
    db
      .prepare('SELECT character_name, discord_user_id FROM raider_identity_map')
      .all() as LinkRow[],
  );

  return characterNames.map((name) => {
    const lower = name.toLowerCase();
    const userId = raiders.get(lower) ?? trials.get(lower) ?? identities.get(lower);
    return userId ? `<@${userId}>` : `**${name}**`;
  });
}

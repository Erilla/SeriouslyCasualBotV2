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
 * everyone else's ping, and it is load-bearing rather than belt-and-braces: the
 * roster sync runs only once a day (06:00, via `dailyMaintenance`), so a trial
 * created after it has no `raiders` row until the next morning.
 *
 * The identity map is gated behind an accepted application. That map is written
 * at application *submission* from a character name the applicant typed, before
 * any officer has decided anything — so an unfiltered read would let a rejected
 * applicant, or anyone who typed an existing raider's character name, be pinged
 * in that character's place. A map entry is trusted only when an `applications`
 * row exists that is `accepted`, belongs to the same Discord user, and names the
 * same character.
 *
 * Order is most-authoritative first: an officer-confirmed roster link beats the
 * trial record, which beats the vetted application link. Inactive raiders
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
      .prepare(
        `SELECT m.character_name, m.discord_user_id FROM raider_identity_map m
          WHERE EXISTS (
            SELECT 1 FROM applications a
              WHERE a.status = 'accepted'
                AND a.applicant_user_id = m.discord_user_id
                AND a.character_name = m.character_name COLLATE NOCASE
          )`,
      )
      .all() as LinkRow[],
  );

  return characterNames.map((name) => {
    const lower = name.toLowerCase();
    const userId = raiders.get(lower) ?? trials.get(lower) ?? identities.get(lower);
    return userId ? `<@${userId}>` : `**${name}**`;
  });
}

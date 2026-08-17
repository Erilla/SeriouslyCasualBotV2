import type { Database } from 'better-sqlite3';
import { logger } from '../../services/logger.js';
import type { RaiderRow, TrialRow } from '../../types/index.js';

/** Our own guild's realm and region, used when nothing better is known. */
export const DEFAULT_REALM = 'silvermoon';
export const DEFAULT_REGION = 'eu';

export type EnsureResult = 'inserted' | 'linked' | 'exists' | 'ignored';

export type EnsurableTrial = Pick<
  TrialRow,
  'character_name' | 'discord_user_id' | 'application_id'
>;

/**
 * Best-known realm and region for a trial's character.
 *
 * `trials` stores no realm, so the only record of one is the applicant intel job
 * that ran for the application. Newest job wins: a re-run corrects an earlier
 * misparse. Falls back to our own guild's realm, which is right for most trials
 * and is corrected by syncRaiders once Raider.IO lists the character.
 */
export function trialRealm(
  db: Database,
  trial: Pick<TrialRow, 'application_id'>,
): { realm: string; region: string } {
  if (trial.application_id === null) {
    return { realm: DEFAULT_REALM, region: DEFAULT_REGION };
  }

  const job = db
    .prepare(
      `SELECT character_realm, character_region FROM applicant_intel_jobs
        WHERE application_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(trial.application_id) as { character_realm: string; character_region: string } | undefined;

  return job
    ? { realm: job.character_realm, region: job.character_region }
    : { realm: DEFAULT_REALM, region: DEFAULT_REGION };
}

/**
 * Give a trial a `raiders` row, because a trial is a roster member.
 *
 * The roster sync cannot do this on its own: it reads the Raider.IO guild roster
 * filtered to ROSTER_RANKS, and a new trial fails that gate both ways — a fresh
 * guild invite sits at rank 8, and Raider.IO does not list a character it has
 * not crawled. Without a row the trial is invisible to every roster consumer,
 * including the signup ping. And the sync only runs once a day at 06:00 (via
 * `dailyMaintenance`), so trial creation calls this directly rather than leaving a
 * trial rowless until the next morning.
 *
 * Idempotent, so both callers (createTrialReviewThread and syncRaiders) can run
 * it freely. Two rows are never created for one character, an ignored character is
 * never resurrected, and an existing Discord link is never overwritten — though
 * a null one is filled, which is the only way an already-inserted unlinked row
 * ever picks up the link the trial record knows about.
 */
export function ensureRaiderForTrial(db: Database, trial: EnsurableTrial): EnsureResult {
  const ignored = db
    .prepare('SELECT 1 FROM ignored_characters WHERE character_name = ? COLLATE NOCASE')
    .get(trial.character_name);

  if (ignored) {
    logger.debug(
      'EnsureTrialRaiders',
      `Trial "${trial.character_name}" is an ignored character; no roster row`,
    );
    return 'ignored';
  }

  const existing = db
    .prepare('SELECT * FROM raiders WHERE character_name = ? COLLATE NOCASE')
    .get(trial.character_name) as RaiderRow | undefined;

  if (existing) {
    if (existing.discord_user_id !== null || trial.discord_user_id === null) return 'exists';

    // Clearing message_id retires any linking post for this raider: the
    // raider-setup refresh sweeps every message it no longer wants to keep.
    db.prepare('UPDATE raiders SET discord_user_id = ?, message_id = NULL WHERE id = ?').run(
      trial.discord_user_id,
      existing.id,
    );
    logger.info(
      'EnsureTrialRaiders',
      `Linked existing roster row for trial "${trial.character_name}" to ${trial.discord_user_id}`,
    );
    return 'linked';
  }

  const { realm, region } = trialRealm(db, trial);

  db.prepare(
    `INSERT INTO raiders (character_name, realm, region, rank, class, discord_user_id)
     VALUES (?, ?, ?, NULL, NULL, ?)`,
  ).run(trial.character_name, realm, region, trial.discord_user_id);

  logger.info(
    'EnsureTrialRaiders',
    `Added trial "${trial.character_name}" (${realm}-${region}) to the roster`,
  );
  return 'inserted';
}

/**
 * Ensure a roster row for every active trial.
 *
 * Returns only the rows this call inserted that have no Discord link, which is
 * what syncRaiders feeds to auto-match and the linking message. Rows that
 * already existed are excluded so the daily 06:00 sync never re-alerts the same
 * raider.
 */
export function ensureRaidersForActiveTrials(db: Database): RaiderRow[] {
  const trials = db
    .prepare(
      `SELECT character_name, discord_user_id, application_id FROM trials
        WHERE status = 'active'`,
    )
    .all() as EnsurableTrial[];

  const insertedUnlinked: RaiderRow[] = [];

  for (const trial of trials) {
    if (ensureRaiderForTrial(db, trial) !== 'inserted') continue;
    if (trial.discord_user_id !== null) continue;

    const row = db
      .prepare('SELECT * FROM raiders WHERE character_name = ? COLLATE NOCASE')
      .get(trial.character_name) as RaiderRow;
    insertedUnlinked.push(row);
  }

  return insertedUnlinked;
}

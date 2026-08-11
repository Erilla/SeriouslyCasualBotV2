import { DiscordAPIError, RESTJSONErrorCodes, type Guild } from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';
import { notifyApplicantDeparture } from '../applications/notifyApplicantDeparture.js';
import { notifyTrialDeparture } from '../trial-review/notifyTrialDeparture.js';

export interface DepartureSweepResult {
  /** Applications awaiting a decision that were checked. */
  checked: number;
  notified: number;
  /** Memberships Discord would not confirm either way; left for the next boot. */
  unresolved: number;
}

type Membership = 'present' | 'departed' | 'unknown';

/**
 * Whether Discord considers this user a member of the guild.
 *
 * The distinction between `departed` and `unknown` is the whole point: a plain
 * `.catch(() => null)` would read a rate limit or a network blip as "they left"
 * and notify overlords about someone still sitting in the server. Only Discord
 * explicitly saying the member or user does not exist counts as a departure.
 */
async function membershipOf(guild: Guild, userId: string): Promise<Membership> {
  try {
    await guild.members.fetch(userId);
    return 'present';
  } catch (error) {
    if (
      error instanceof DiscordAPIError &&
      (error.code === RESTJSONErrorCodes.UnknownMember ||
        error.code === RESTJSONErrorCodes.UnknownUser)
    ) {
      return 'departed';
    }
    logger.warn(
      'Applications',
      `Could not determine whether ${userId} is still in the guild; leaving it for the next boot: ${error}`,
    );
    return 'unknown';
  }
}

/**
 * Catch up on applicants who left while this process was not running.
 *
 * The gateway only delivers `guildMemberRemove` to a connected client, and every
 * deploy restarts this bot — so without this sweep those departures are lost
 * silently. It runs once per boot over applications awaiting a decision that
 * nobody has been notified about, which in practice is zero or a handful of rows,
 * so a per-member fetch is cheaper than pulling the whole member list.
 *
 * Never throws: a failure here must not stop startup.
 */
async function sweepApplications(guild: Guild): Promise<DepartureSweepResult> {
  const result: DepartureSweepResult = { checked: 0, notified: 0, unresolved: 0 };

  try {
    const pending = getDatabase()
      .prepare(
        `SELECT id, applicant_user_id FROM applications
          WHERE status = 'active' AND departed_notified_at IS NULL
          ORDER BY id`,
      )
      .all() as { id: number; applicant_user_id: string }[];

    for (const application of pending) {
      result.checked += 1;

      const membership = await membershipOf(guild, application.applicant_user_id);
      if (membership === 'present') continue;
      if (membership === 'unknown') {
        result.unresolved += 1;
        continue;
      }

      // The applicant has left, so their tag is no longer available from the
      // guild. It is only ever a fallback for a missing character name, so the
      // user id is an acceptable last resort.
      const user = await guild.client.users.fetch(application.applicant_user_id).catch(() => null);
      const outcome = await notifyApplicantDeparture(guild, {
        userId: application.applicant_user_id,
        tag: user?.tag ?? application.applicant_user_id,
      });
      if (outcome === 'notified') result.notified += 1;
    }
  } catch (error) {
    logger.error(
      'Applications',
      `Departure sweep failed: ${error}`,
      error instanceof Error ? error : undefined,
    );
  }

  return result;
}

async function sweepTrials(guild: Guild): Promise<DepartureSweepResult> {
  const result: DepartureSweepResult = { checked: 0, notified: 0, unresolved: 0 };

  try {
    // A NULL discord_user_id is not a candidate: nobody linked this trial, so there
    // is no membership to check and nothing to report.
    const pending = getDatabase()
      .prepare(
        `SELECT id, character_name, discord_user_id FROM trials
          WHERE status = 'active'
            AND discord_user_id IS NOT NULL
            AND departed_notified_at IS NULL
          ORDER BY id`,
      )
      .all() as { id: number; character_name: string; discord_user_id: string }[];

    for (const trial of pending) {
      result.checked += 1;

      const membership = await membershipOf(guild, trial.discord_user_id);
      if (membership === 'present') continue;
      if (membership === 'unknown') {
        result.unresolved += 1;
        continue;
      }

      // They have left, so their tag is no longer available from the guild. The
      // copy uses the trial's character name, so the tag is only for the log line.
      const user = await guild.client.users.fetch(trial.discord_user_id).catch(() => null);
      const outcome = await notifyTrialDeparture(guild, {
        userId: trial.discord_user_id,
        tag: user?.tag ?? trial.discord_user_id,
      });
      if (outcome === 'notified') result.notified += 1;
    }
  } catch (error) {
    logger.error(
      'Trials',
      `Trial departure sweep failed: ${error}`,
      error instanceof Error ? error : undefined,
    );
  }

  return result;
}

export interface DeparturesSweepResult {
  applications: DepartureSweepResult;
  trials: DepartureSweepResult;
}

/**
 * Catch up on applicants and trials who left while this process was not running.
 *
 * The gateway only delivers `guildMemberRemove` to a connected client, and every
 * deploy restarts this bot — so without this sweep those departures are lost
 * silently. Two passes over two tables, sharing one membership check, because the
 * expensive part is asking Discord and the answer is the same question either way.
 *
 * Never throws: a failure here must not stop startup.
 */
export async function sweepDepartures(guild: Guild): Promise<DeparturesSweepResult> {
  return {
    applications: await sweepApplications(guild),
    trials: await sweepTrials(guild),
  };
}

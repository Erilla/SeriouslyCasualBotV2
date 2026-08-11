import type { Guild } from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';
import { auditNotice } from '../../services/auditLog.js';
import { asSendable } from '../../utils.js';
import { getOverlords } from '../raids/overlords.js';
import {
  TRIAL_DEPARTURE_AUDIT_TITLE,
  buildDepartureAuditDetail,
  buildDepartureNotification,
  type DepartureFacts,
} from '../applications/departureNotification.js';

/** The subset of a trial row a departure notification needs. */
interface DepartureTrial {
  id: number;
  character_name: string;
  thread_id: string | null;
}

export interface DepartedTrialMember {
  userId: string;
  /** Discord tag, for the logs — a trial always has a character name for the copy. */
  tag: string;
}

export type TrialDepartureOutcome = 'notified' | 'no_trial' | 'no_thread' | 'send_failed';

/**
 * The trial this departure concerns, if there is one to tell overlords about.
 *
 * `status = 'active'` is a trial in progress. `promoted` is deliberately excluded:
 * they are a full raider by then, and a raider leaving is a different event with a
 * different audience. `closed` is over.
 *
 * A NULL `discord_user_id` cannot match, which is how trials nobody has linked stay
 * silent rather than being guessed at. A non-NULL `departed_notified_at` means
 * overlords have already been told, which is what stops the boot sweep re-notifying
 * after every redeploy.
 */
export function findUnnotifiedDepartureTrial(discordUserId: string): DepartureTrial | undefined {
  return getDatabase()
    .prepare(
      `SELECT id, character_name, thread_id FROM trials
        WHERE discord_user_id = ?
          AND status = 'active'
          AND departed_notified_at IS NULL
        ORDER BY id DESC LIMIT 1`,
    )
    .get(discordUserId) as DepartureTrial | undefined;
}

function markNotified(trialId: number): void {
  getDatabase()
    .prepare("UPDATE trials SET departed_notified_at = datetime('now') WHERE id = ?")
    .run(trialId);
}

/**
 * Tell overlords that a trial in progress has left the Discord.
 *
 * The trial counterpart of `notifyApplicantDeparture`, and deliberately its twin:
 * shared by the live `guildMemberRemove` handler and the boot sweep, so both paths
 * produce the same message and the same once-only guarantee. Callers do not need to
 * check eligibility first — this returns `no_trial` when there is nothing to report.
 *
 * Notify only. The trial's status, its review alerts and its promote alerts are all
 * left alone: clicking **Close trial** already cancels the alerts, so the nudge to
 * close is what stops the noise, and nothing is decided for the officers.
 *
 * The row is stamped only after the post succeeds, so a failure leaves the work for
 * the next sweep rather than silently swallowing the notification. The audit mirror
 * is best-effort and never blocks the stamp: it is a searchable record of something
 * overlords have already been pinged about.
 */
export async function notifyTrialDeparture(
  guild: Guild,
  member: DepartedTrialMember,
): Promise<TrialDepartureOutcome> {
  const trial = findUnnotifiedDepartureTrial(member.userId);
  if (!trial) return 'no_trial';

  if (!trial.thread_id) {
    logger.warn(
      'Trials',
      `Trial #${trial.id}: ${trial.character_name} left, but the trial has no thread to post in`,
    );
    return 'no_thread';
  }

  const facts: DepartureFacts = {
    subject: 'trial',
    characterName: trial.character_name,
    tag: member.tag,
    userId: member.userId,
    reference: `trial #${trial.id}`,
    closingAction: 'Close the trial to tidy it up.',
  };

  const channel =
    guild.channels.cache.get(trial.thread_id) ??
    (await guild.channels.fetch(trial.thread_id).catch(() => null));
  const thread = asSendable(channel);
  if (!thread) {
    logger.warn(
      'Trials',
      `Trial #${trial.id}: thread ${trial.thread_id} is missing or not sendable`,
    );
    return 'no_thread';
  }

  try {
    const overlordIds = getOverlords().map((overlord) => overlord.user_id);
    await thread.send(buildDepartureNotification(overlordIds, facts));
  } catch (error) {
    logger.error(
      'Trials',
      `Trial #${trial.id}: failed to post departure notification: ${error}`,
      error as Error,
    );
    return 'send_failed';
  }

  markNotified(trial.id);
  logger.info(
    'Trials',
    `Trial #${trial.id}: notified overlords that ${trial.character_name} (${member.tag}) left the server`,
  );

  // Best-effort, and after the stamp: auditNotice swallows its own failures, but a
  // rejected promise here must not undo a notification that already landed.
  await auditNotice(TRIAL_DEPARTURE_AUDIT_TITLE, buildDepartureAuditDetail(facts)).catch(
    () => undefined,
  );

  return 'notified';
}

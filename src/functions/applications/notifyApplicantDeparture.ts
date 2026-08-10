import type { Guild } from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';
import { auditNotice } from '../../services/auditLog.js';
import { asSendable } from '../../utils.js';
import { getOverlords } from '../raids/overlords.js';
import {
  DEPARTURE_AUDIT_TITLE,
  buildDepartureAuditDetail,
  buildDepartureNotification,
} from './departureNotification.js';

/** The subset of an application row a departure notification needs. */
interface DepartureApplication {
  id: number;
  character_name: string | null;
  thread_id: string | null;
}

export interface DepartedApplicant {
  userId: string;
  /** Discord tag, used when the application never captured a character name. */
  tag: string;
}

export type DepartureOutcome = 'notified' | 'no_application' | 'no_thread' | 'send_failed';

/**
 * The application this departure concerns, if there is one to tell overlords about.
 *
 * `status = 'active'` is the awaiting-decision state, set on submission
 * (`submitApplication.ts`). Note this is *not* `'submitted'`, which production
 * never writes — see #95. An `in_progress` applicant is deliberately excluded:
 * they have no post or channel, so there is nothing for an overlord to act on.
 *
 * A non-NULL `departed_notified_at` means overlords have already been told, which
 * is what stops the startup sweep re-notifying after every redeploy.
 */
export function findUnnotifiedDepartureApplication(
  applicantUserId: string,
): DepartureApplication | undefined {
  return getDatabase()
    .prepare(
      `SELECT id, character_name, thread_id FROM applications
        WHERE applicant_user_id = ?
          AND status = 'active'
          AND departed_notified_at IS NULL
        ORDER BY id DESC LIMIT 1`,
    )
    .get(applicantUserId) as DepartureApplication | undefined;
}

function markNotified(applicationId: number): void {
  getDatabase()
    .prepare("UPDATE applications SET departed_notified_at = datetime('now') WHERE id = ?")
    .run(applicationId);
}

/**
 * Tell overlords that an applicant awaiting a decision has left the Discord.
 *
 * Shared by the live `guildMemberRemove` handler and the startup sweep, so both
 * paths produce the same message and the same once-only guarantee. Callers do not
 * need to check eligibility first — this returns `no_application` when there is
 * nothing to report.
 *
 * Notify only: the application's status is deliberately untouched. Auto-abandoning
 * would be irreversible if someone leaves and rejoins, and a rejoin means a fresh
 * application anyway.
 *
 * The row is stamped only after the post succeeds, so a failure leaves the work
 * for the next sweep rather than silently swallowing the notification. The audit
 * mirror is best-effort and never blocks the stamp: it is a searchable record of
 * something overlords have already been pinged about.
 */
export async function notifyApplicantDeparture(
  guild: Guild,
  applicant: DepartedApplicant,
): Promise<DepartureOutcome> {
  const application = findUnnotifiedDepartureApplication(applicant.userId);
  if (!application) return 'no_application';

  if (!application.thread_id) {
    logger.warn(
      'Applications',
      `Application #${application.id}: applicant ${applicant.tag} left, but the application has no thread to post in`,
    );
    return 'no_thread';
  }

  const facts = {
    characterName: application.character_name,
    applicantTag: applicant.tag,
    applicantUserId: applicant.userId,
    applicationId: application.id,
  };

  const channel =
    guild.channels.cache.get(application.thread_id) ??
    (await guild.channels.fetch(application.thread_id).catch(() => null));
  const thread = asSendable(channel);
  if (!thread) {
    logger.warn(
      'Applications',
      `Application #${application.id}: thread ${application.thread_id} is missing or not sendable`,
    );
    return 'no_thread';
  }

  try {
    const overlordIds = getOverlords().map((overlord) => overlord.user_id);
    await thread.send(buildDepartureNotification(overlordIds, facts));
  } catch (error) {
    logger.error(
      'Applications',
      `Application #${application.id}: failed to post departure notification: ${error}`,
      error as Error,
    );
    return 'send_failed';
  }

  markNotified(application.id);
  logger.info(
    'Applications',
    `Application #${application.id}: notified overlords that ${applicant.tag} left the server`,
  );

  // Best-effort, and after the stamp: auditNotice swallows its own failures, but
  // a rejected promise here must not undo a notification that already landed.
  await auditNotice(DEPARTURE_AUDIT_TITLE, buildDepartureAuditDetail(facts)).catch(() => undefined);

  return 'notified';
}

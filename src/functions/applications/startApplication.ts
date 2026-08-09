import type { GuildMember, User } from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';
import { getQuestions } from './applicationQuestions.js';
import { activeSessions, startSessionTimeout } from './dmQuestionnaire.js';
import type { ApplicationRow, ConfigRow } from '../../types/index.js';

/** How long a rejected applicant must wait before applying again. */
export const REAPPLY_AFTER_DAYS = 7;

export type StartApplicationRefusal =
  | 'already_raider'
  | 'already_accepted'
  | 'application_pending'
  | 'recently_rejected';

export type StartApplicationResult =
  | { outcome: 'started' }
  | { outcome: 'dm_failed' }
  | { outcome: 'refused'; reason: StartApplicationRefusal; message: string };

type RefusedResult = Extract<StartApplicationResult, { outcome: 'refused' }>;

/** Whether the applicant is already a raider, so there is nothing to apply for. */
function hasRaiderRole(member: GuildMember | null): boolean {
  // A member we could not resolve is not evidence of anything — never refuse on it.
  if (!member) return false;

  const roleId = (
    getDatabase().prepare('SELECT value FROM config WHERE key = ?').get('raider_role_id') as
      | ConfigRow
      | undefined
  )?.value;
  if (!roleId) return false;

  return member.roles.cache.has(roleId);
}

/**
 * Refuse the application if the applicant already has one that counts.
 *
 * 'in_progress' is deliberately absent: the caller resumes those instead.
 * 'abandoned' is absent too — a cancelled or timed-out attempt should never
 * block a genuine retry. Date arithmetic stays in SQLite so it is done against
 * the same clock and UTC representation that wrote resolved_at.
 */
function findBlockingApplication(userId: string): RefusedResult | null {
  const db = getDatabase();

  const settled = db
    .prepare(
      `SELECT status FROM applications
        WHERE applicant_user_id = ? AND status IN ('submitted', 'active', 'accepted')
        ORDER BY id DESC LIMIT 1`,
    )
    .get(userId) as { status: string } | undefined;

  if (settled?.status === 'accepted') {
    return {
      outcome: 'refused',
      reason: 'already_accepted',
      message:
        'Your application has already been accepted. If something looks wrong, please contact an officer.',
    };
  }

  if (settled) {
    return {
      outcome: 'refused',
      reason: 'application_pending',
      message:
        'You already have an application awaiting a decision. Officers will get back to you — ' +
        'it can take up to a week.',
    };
  }

  const rejected = db
    .prepare(
      `SELECT strftime('%s', resolved_at, '+${REAPPLY_AFTER_DAYS} days') AS retry_epoch
         FROM applications
        WHERE applicant_user_id = ?
          AND status = 'rejected'
          AND resolved_at IS NOT NULL
          AND datetime(resolved_at, '+${REAPPLY_AFTER_DAYS} days') > datetime('now')
        ORDER BY resolved_at DESC LIMIT 1`,
    )
    .get(userId) as { retry_epoch: string } | undefined;

  if (rejected) {
    return {
      outcome: 'refused',
      reason: 'recently_rejected',
      // A Discord timestamp renders in each reader's own timezone, which a
      // formatted UTC string would not.
      message:
        `Your last application was declined. You're welcome to apply again after ` +
        `<t:${rejected.retry_epoch}:F>.`,
    };
  }

  return null;
}

/**
 * Start (or resume) a DM questionnaire for a user.
 *
 * `member` is optional so callers outside a guild context still work; when it is
 * absent the raider-role check is skipped rather than assumed either way.
 */
export async function startApplication(
  user: User,
  member: GuildMember | null = null,
): Promise<StartApplicationResult> {
  const db = getDatabase();

  const questions = getQuestions();

  if (questions.length === 0) {
    try {
      await user.send(
        'No application questions are currently configured. Please contact an officer.',
      );
      return { outcome: 'started' };
    } catch {
      return { outcome: 'dm_failed' };
    }
  }

  // Clean up any stale in-memory session for this user before proceeding.
  // This prevents duplicate messages if a previous session wasn't fully cleaned up.
  const staleSession = activeSessions.get(user.id);
  if (staleSession?.timeout) {
    clearTimeout(staleSession.timeout);
  }
  activeSessions.delete(user.id);

  if (hasRaiderRole(member)) {
    logger.info(
      'Applications',
      `Refused application from ${user.tag}: already has the raider role`,
    );
    return {
      outcome: 'refused',
      reason: 'already_raider',
      message: "You're already a raider — there's no need to apply.",
    };
  }

  // Check for existing in_progress application
  const existing = db
    .prepare('SELECT * FROM applications WHERE applicant_user_id = ? AND status = ?')
    .get(user.id, 'in_progress') as ApplicationRow | undefined;

  if (existing) {
    // Resume from where they left off - return immediately, no other code path runs
    return await resumeApplication(user, existing, questions);
  }

  // Only reached when there is nothing to resume, so this never interferes with
  // an application the applicant is still filling in.
  const blocked = findBlockingApplication(user.id);
  if (blocked) {
    logger.info('Applications', `Refused application from ${user.tag}: ${blocked.reason}`);
    return blocked;
  }

  // No in_progress application exists - create a new one
  return await createNewApplication(user, questions);
}

async function resumeApplication(
  user: User,
  application: ApplicationRow,
  questions: { id: number; question: string; sort_order: number }[],
): Promise<StartApplicationResult> {
  const db = getDatabase();

  // Verify the existing answers still align with current questions.
  // If questions have changed (added/removed), abandon the old application and start fresh.
  const answeredQuestionIds = db
    .prepare('SELECT question_id FROM application_answers WHERE application_id = ?')
    .all(application.id) as { question_id: number }[];

  const currentQuestionIds = new Set(questions.map((q) => q.id));
  const hasOrphanedAnswers = answeredQuestionIds.some(
    (a) => !currentQuestionIds.has(a.question_id),
  );

  if (hasOrphanedAnswers) {
    logger.info(
      'Applications',
      `Application #${application.id} has orphaned answers (questions changed) - abandoning and starting fresh`,
    );
    db.prepare('UPDATE applications SET status = ? WHERE id = ?').run('abandoned', application.id);

    // Create a fresh application instead
    return await createNewApplication(user, questions);
  }

  // Find which question to resume from
  const questionIndex = answeredQuestionIds.length;

  if (questionIndex >= questions.length) {
    // All questions answered - they need to see the summary
    // Import dynamically to avoid circular dependency
    const { showSummary } = await import('./dmQuestionnaire.js');
    try {
      await showSummary(user, application.id);
      return { outcome: 'started' };
    } catch {
      return { outcome: 'dm_failed' };
    }
  }

  // Resume from current question
  activeSessions.set(user.id, {
    applicationId: application.id,
    questionIndex,
  });

  startSessionTimeout(user);

  // Update current_question_id
  db.prepare('UPDATE applications SET current_question_id = ? WHERE id = ?').run(
    questions[questionIndex].id,
    application.id,
  );

  try {
    await user.send(
      `Welcome back! Resuming your application.\n\n**Application Question ${questionIndex + 1}/${questions.length}:**\n${questions[questionIndex].question}`,
    );
    return { outcome: 'started' };
  } catch {
    activeSessions.delete(user.id);
    return { outcome: 'dm_failed' };
  }
}

/**
 * Create a brand-new application and send the first question.
 */
async function createNewApplication(
  user: User,
  questions: { id: number; question: string; sort_order: number }[],
): Promise<StartApplicationResult> {
  const db = getDatabase();

  // Seed character_name with the applicant's Discord display name. The
  // questionnaire doesn't ask for a character name (the first question is
  // class/spec), so the Discord name is the best identifier for the channel
  // name, post header, and officer prefills until an officer sets the real
  // character name on accept.
  const result = db
    .prepare(
      'INSERT INTO applications (applicant_user_id, status, current_question_id, character_name) VALUES (?, ?, ?, ?)',
    )
    .run(user.id, 'in_progress', questions[0].id, user.displayName);

  const applicationId = result.lastInsertRowid as number;

  logger.info('Applications', `New application #${applicationId} started by ${user.tag}`);

  activeSessions.set(user.id, {
    applicationId,
    questionIndex: 0,
  });

  startSessionTimeout(user);

  try {
    await user.send(`**Application Question 1/${questions.length}:**\n${questions[0].question}`);
    return { outcome: 'started' };
  } catch {
    activeSessions.delete(user.id);
    db.prepare('UPDATE applications SET status = ? WHERE id = ?').run('abandoned', applicationId);
    return { outcome: 'dm_failed' };
  }
}

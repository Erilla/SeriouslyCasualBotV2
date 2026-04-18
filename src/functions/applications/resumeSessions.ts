import type { Client, User } from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';
import { activeSessions, startSessionTimeout } from './dmQuestionnaire.js';
import type { ApplicationRow, ApplicationQuestionRow } from '../../types/index.js';

/**
 * Resume in-progress DM application sessions after a bot restart.
 * Queries the DB for all applications with status='in_progress', determines
 * which question each applicant was on, restores the session, and DMs the user.
 */
export async function resumeSessions(client: Client): Promise<void> {
  const db = getDatabase();

  const inProgress = db
    .prepare(`SELECT * FROM applications WHERE status = 'in_progress'`)
    .all() as ApplicationRow[];

  if (inProgress.length === 0) {
    logger.info('Applications', 'resumeSessions: no in-progress sessions to restore');
    return;
  }

  const questions = db
    .prepare('SELECT * FROM application_questions ORDER BY sort_order')
    .all() as ApplicationQuestionRow[];

  let resumed = 0;
  let skipped = 0;

  for (const app of inProgress) {
    const { count } = db
      .prepare('SELECT COUNT(*) as count FROM application_answers WHERE application_id = ?')
      .get(app.id) as { count: number };

    // If all questions are answered the user was at the summary stage - skip
    if (questions.length > 0 && count >= questions.length) {
      logger.debug(
        'Applications',
        `resumeSessions: application #${app.id} (user ${app.applicant_user_id}) is at summary stage, skipping`,
      );
      skipped++;
      continue;
    }

    // questionIndex is the next unanswered question
    const questionIndex = count;
    const nextQuestion = questions[questionIndex];

    if (!nextQuestion) {
      logger.warn(
        'Applications',
        `resumeSessions: application #${app.id} has questionIndex=${questionIndex} but no question at that index, skipping`,
      );
      skipped++;
      continue;
    }

    // Restore session
    activeSessions.set(app.applicant_user_id, {
      applicationId: app.id,
      questionIndex,
    });

    let user: User | undefined;
    try {
      user = await client.users.fetch(app.applicant_user_id);
    } catch {
      logger.warn(
        'Applications',
        `resumeSessions: could not fetch user ${app.applicant_user_id} for application #${app.id}`,
      );
      activeSessions.delete(app.applicant_user_id);
      skipped++;
      continue;
    }

    // Set up the inactivity timeout
    startSessionTimeout(user);

    // DM the user to resume
    try {
      await user.send(
        `Sorry, I had to restart! Let's continue where we left off.\n\nQuestion ${questionIndex + 1}/${questions.length}: ${nextQuestion.question}`,
      );
      logger.info(
        'Applications',
        `resumeSessions: resumed application #${app.id} for ${user.tag} at question ${questionIndex + 1}/${questions.length}`,
      );
      resumed++;
    } catch {
      logger.warn(
        'Applications',
        `resumeSessions: could not DM user ${user.tag} (${app.applicant_user_id}) for application #${app.id} - DMs may be disabled`,
      );
      // Leave session in activeSessions so handleDmMessage can still process if they reply
    }
  }

  logger.info(
    'Applications',
    `resumeSessions: complete — ${resumed} resumed, ${skipped} skipped out of ${inProgress.length} in-progress`,
  );
}

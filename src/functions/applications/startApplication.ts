import type { User } from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';
import { getQuestions } from './applicationQuestions.js';
import { activeSessions, startSessionTimeout } from './dmQuestionnaire.js';
import type { ApplicationRow } from '../../types/index.js';

/**
 * Start (or resume) a DM questionnaire for a user.
 * Returns true if DM was sent successfully, false if DMs are disabled.
 */
export async function startApplication(user: User): Promise<boolean> {
  const db = getDatabase();

  const questions = getQuestions();

  if (questions.length === 0) {
    try {
      await user.send('No application questions are currently configured. Please contact an officer.');
      return true;
    } catch {
      return false;
    }
  }

  // Clean up any stale in-memory session for this user before proceeding.
  // This prevents duplicate messages if a previous session wasn't fully cleaned up.
  const staleSession = activeSessions.get(user.id);
  if (staleSession?.timeout) {
    clearTimeout(staleSession.timeout);
  }
  activeSessions.delete(user.id);

  // Check for existing in_progress application
  const existing = db
    .prepare('SELECT * FROM applications WHERE applicant_user_id = ? AND status = ?')
    .get(user.id, 'in_progress') as ApplicationRow | undefined;

  if (existing) {
    // Resume from where they left off - return immediately, no other code path runs
    return await resumeApplication(user, existing, questions);
  }

  // No in_progress application exists - create a new one
  return await createNewApplication(user, questions);
}

async function resumeApplication(
  user: User,
  application: ApplicationRow,
  questions: { id: number; question: string; sort_order: number }[],
): Promise<boolean> {
  const db = getDatabase();

  // Verify the existing answers still align with current questions.
  // If questions have changed (added/removed), abandon the old application and start fresh.
  const answeredQuestionIds = db
    .prepare('SELECT question_id FROM application_answers WHERE application_id = ?')
    .all(application.id) as { question_id: number }[];

  const currentQuestionIds = new Set(questions.map((q) => q.id));
  const hasOrphanedAnswers = answeredQuestionIds.some((a) => !currentQuestionIds.has(a.question_id));

  if (hasOrphanedAnswers) {
    logger.info('Applications', `Application #${application.id} has orphaned answers (questions changed) - abandoning and starting fresh`);
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
      return true;
    } catch {
      return false;
    }
  }

  // Resume from current question
  activeSessions.set(user.id, {
    applicationId: application.id,
    questionIndex,
  });

  startSessionTimeout(user);

  // Update current_question_id
  db.prepare('UPDATE applications SET current_question_id = ? WHERE id = ?')
    .run(questions[questionIndex].id, application.id);

  try {
    await user.send(
      `Welcome back! Resuming your application.\n\n**Application Question ${questionIndex + 1}/${questions.length}:**\n${questions[questionIndex].question}`,
    );
    return true;
  } catch {
    activeSessions.delete(user.id);
    return false;
  }
}

/**
 * Create a brand-new application and send the first question.
 */
async function createNewApplication(
  user: User,
  questions: { id: number; question: string; sort_order: number }[],
): Promise<boolean> {
  const db = getDatabase();

  const result = db
    .prepare('INSERT INTO applications (applicant_user_id, status, current_question_id) VALUES (?, ?, ?)')
    .run(user.id, 'in_progress', questions[0].id);

  const applicationId = result.lastInsertRowid as number;

  logger.info('Applications', `New application #${applicationId} started by ${user.tag}`);

  activeSessions.set(user.id, {
    applicationId,
    questionIndex: 0,
  });

  startSessionTimeout(user);

  try {
    await user.send(`**Application Question 1/${questions.length}:**\n${questions[0].question}`);
    return true;
  } catch {
    activeSessions.delete(user.id);
    db.prepare('UPDATE applications SET status = ? WHERE id = ?').run('abandoned', applicationId);
    return false;
  }
}

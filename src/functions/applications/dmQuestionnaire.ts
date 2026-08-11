import { MessageFlags, type Message, type User } from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';
import { getQuestions } from './applicationQuestions.js';
import { buildSummaryRow } from './summaryButtons.js';
import { formatQaBlock, splitQaText } from './qaFormat.js';

// ─── Session Tracking ─────────────────────────────────────────

export interface ApplicationSession {
  applicationId: number;
  questionIndex: number;
  editMode?: 'awaiting_number' | 'awaiting_answer';
  editQuestionIndex?: number;
  timeout?: ReturnType<typeof setTimeout>;
}

/** Map of Discord user ID -> active DM session */
export const activeSessions = new Map<string, ApplicationSession>();

const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Drop a user's DM session and disarm its inactivity timeout.
 *
 * Deleting the map entry alone is not enough: the pending setTimeout closes over
 * the user and still fires, and its callback marks the application 'abandoned'.
 * Any path that ends a session for good must come through here.
 */
export function clearSession(userId: string): void {
  const session = activeSessions.get(userId);
  if (session?.timeout) clearTimeout(session.timeout);
  activeSessions.delete(userId);
}

/**
 * Start or reset the inactivity timeout for a session.
 */
export function startSessionTimeout(user: User): void {
  const session = activeSessions.get(user.id);
  if (!session) return;

  // Clear existing timeout
  if (session.timeout) {
    clearTimeout(session.timeout);
  }

  session.timeout = setTimeout(async () => {
    const s = activeSessions.get(user.id);
    if (!s) return;

    activeSessions.delete(user.id);

    // Only ever retire an application that is still genuinely unfinished. The
    // conditions match the submission claim: a row that has been submitted, or
    // is being submitted right now, must not be abandoned out from under the
    // applicant — that silently retired live applications whose channel and
    // forum thread stayed standing.
    const db = getDatabase();
    const abandoned = db
      .prepare(
        `UPDATE applications SET status = 'abandoned'
          WHERE id = ? AND status = 'in_progress' AND submitted_at IS NULL`,
      )
      .run(s.applicationId);

    if (abandoned.changes === 0) {
      logger.debug(
        'Applications',
        `Session for application #${s.applicationId} timed out but the application was no longer open; left as-is`,
      );
      return;
    }

    try {
      await user.send('Your application has timed out. You can restart with /apply.');
    } catch {
      // DMs may be disabled
    }

    logger.info('Applications', `Application #${s.applicationId} timed out for ${user.tag}`);
  }, SESSION_TIMEOUT_MS);
}

// ─── DM Message Handler ───────────────────────────────────────

/**
 * Handle an incoming DM message from a user who may be in an active application session.
 */
export async function handleDmMessage(message: Message): Promise<void> {
  const session = activeSessions.get(message.author.id);
  if (!session) return;

  // Reset timeout on each response
  startSessionTimeout(message.author);

  // Handle edit mode
  if (session.editMode === 'awaiting_number') {
    await handleEditNumberResponse(message, session);
    return;
  }

  if (session.editMode === 'awaiting_answer') {
    await handleEditAnswerResponse(message, session);
    return;
  }

  // Normal questionnaire flow
  await handleQuestionResponse(message, session);
}

// ─── Normal Question Flow ─────────────────────────────────────

async function handleQuestionResponse(
  message: Message,
  session: ApplicationSession,
): Promise<void> {
  const db = getDatabase();
  const questions = getQuestions();
  const currentQuestion = questions[session.questionIndex];

  if (!currentQuestion) {
    logger.warn(
      'Applications',
      `No question at index ${session.questionIndex} for application #${session.applicationId}`,
    );
    return;
  }

  // Store the answer
  db.prepare(
    'INSERT INTO application_answers (application_id, question_id, answer) VALUES (?, ?, ?)',
  ).run(session.applicationId, currentQuestion.id, message.content);

  logger.debug(
    'Applications',
    `Answer recorded for application #${session.applicationId}, question #${currentQuestion.id} (${session.questionIndex + 1}/${getQuestions().length})`,
  );

  // Advance to next question
  const nextIndex = session.questionIndex + 1;

  if (nextIndex < questions.length) {
    // More questions to ask
    session.questionIndex = nextIndex;

    db.prepare('UPDATE applications SET current_question_id = ? WHERE id = ?').run(
      questions[nextIndex].id,
      session.applicationId,
    );

    await message.author.send(
      `**Application Question ${nextIndex + 1}/${questions.length}:**\n${questions[nextIndex].question}`,
    );
  } else {
    // All questions answered - show summary
    activeSessions.delete(message.author.id);
    if (session.timeout) clearTimeout(session.timeout);

    await showSummary(message.author, session.applicationId);
  }
}

// ─── Edit Flow ────────────────────────────────────────────────

async function handleEditNumberResponse(
  message: Message,
  session: ApplicationSession,
): Promise<void> {
  const questions = getQuestions();
  const num = parseInt(message.content.trim(), 10);

  if (isNaN(num) || num < 1 || num > questions.length) {
    await message.author.send(`Please enter a number between 1 and ${questions.length}.`);
    return;
  }

  session.editMode = 'awaiting_answer';
  session.editQuestionIndex = num - 1;

  logger.debug(
    'Applications',
    `User ${message.author.id} entered edit mode for question ${num} on application #${session.applicationId}`,
  );

  const question = questions[num - 1];
  await message.author.send(`**Editing Answer ${num}:**\n${question.question}`);
}

async function handleEditAnswerResponse(
  message: Message,
  session: ApplicationSession,
): Promise<void> {
  const db = getDatabase();
  const questions = getQuestions();
  const questionIndex = session.editQuestionIndex!;
  const question = questions[questionIndex];

  // Update the answer in DB
  const existingAnswer = db
    .prepare('SELECT id FROM application_answers WHERE application_id = ? AND question_id = ?')
    .get(session.applicationId, question.id) as { id: number } | undefined;

  if (existingAnswer) {
    db.prepare('UPDATE application_answers SET answer = ? WHERE id = ?').run(
      message.content,
      existingAnswer.id,
    );
    logger.info(
      'Applications',
      `Edited answer for application #${session.applicationId}, question #${question.id}`,
    );
  } else {
    db.prepare(
      'INSERT INTO application_answers (application_id, question_id, answer) VALUES (?, ?, ?)',
    ).run(session.applicationId, question.id, message.content);
    logger.info(
      'Applications',
      `Inserted edited answer for application #${session.applicationId}, question #${question.id} (no prior answer)`,
    );
  }

  // Clear edit mode and re-display summary
  session.editMode = undefined;
  session.editQuestionIndex = undefined;

  // Remove from active sessions since summary re-displays with buttons
  activeSessions.delete(message.author.id);
  if (session.timeout) clearTimeout(session.timeout);

  await showSummary(message.author, session.applicationId);
}

// ─── Summary Display ──────────────────────────────────────────

/**
 * Show the application summary with Edit/Confirm/Cancel buttons.
 */
export async function showSummary(user: User, applicationId: number): Promise<void> {
  const db = getDatabase();

  const answers = db
    .prepare(
      `SELECT aq.question, aa.answer, aq.sort_order
       FROM application_answers aa
       JOIN application_questions aq ON aa.question_id = aq.id
       WHERE aa.application_id = ?
       ORDER BY aq.sort_order`,
    )
    .all(applicationId) as Array<{ question: string; answer: string; sort_order: number }>;

  if (answers.length === 0) {
    await user.send('Something went wrong - no answers found for your application.');
    return;
  }

  // Build summary text. Same formatting as the posted Q&A, so what the applicant
  // approves here is what the officers read.
  let summary = '**Application Summary**\n\n';
  for (let i = 0; i < answers.length; i++) {
    summary += `${formatQaBlock(i, answers[i].question, answers[i].answer)}\n\n`;
  }

  for (const msg of splitQaText(summary)) {
    await user.send({ content: msg, flags: MessageFlags.SuppressEmbeds });
  }

  const row = buildSummaryRow(applicationId);

  const confirmPrompt =
    'We try to review and respond to applications as quickly as we can. Please be warned that it can take up to a week for us to come to a decision.\n\n' +
    'Would you like to submit your application?';

  await user.send({ content: confirmPrompt, components: [row] });
}

/**
 * Enter edit mode for an application. Called from button handler.
 */
export function enterEditMode(userId: string, applicationId: number): void {
  activeSessions.set(userId, {
    applicationId,
    questionIndex: 0,
    editMode: 'awaiting_number',
  });
}

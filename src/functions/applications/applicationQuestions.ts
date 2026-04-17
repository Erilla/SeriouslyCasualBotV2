import { getDatabase } from '../../database/db.js';
import type { ApplicationQuestionRow } from '../../types/index.js';

/**
 * Get all application questions ordered by sort_order.
 */
export function getQuestions(): ApplicationQuestionRow[] {
  const db = getDatabase();
  return db
    .prepare('SELECT * FROM application_questions ORDER BY sort_order')
    .all() as ApplicationQuestionRow[];
}

/**
 * Get a single question by ID.
 */
export function getQuestionById(id: number): ApplicationQuestionRow | undefined {
  const db = getDatabase();
  return db
    .prepare('SELECT * FROM application_questions WHERE id = ?')
    .get(id) as ApplicationQuestionRow | undefined;
}

/**
 * Add a new question with auto-incrementing sort_order.
 */
export function addQuestion(question: string): ApplicationQuestionRow {
  const db = getDatabase();
  const maxRow = db
    .prepare('SELECT MAX(sort_order) as max_order FROM application_questions')
    .get() as { max_order: number | null };
  const nextOrder = (maxRow.max_order ?? 0) + 1;

  const result = db
    .prepare('INSERT INTO application_questions (question, sort_order) VALUES (?, ?)')
    .run(question, nextOrder);

  return {
    id: result.lastInsertRowid as number,
    question,
    sort_order: nextOrder,
  };
}

/**
 * Remove a question by ID.
 * Returns true if a row was deleted, false otherwise.
 */
export function removeQuestion(id: number): boolean {
  const db = getDatabase();
  const result = db
    .prepare('DELETE FROM application_questions WHERE id = ?')
    .run(id);
  return result.changes > 0;
}

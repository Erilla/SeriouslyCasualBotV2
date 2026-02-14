import { getDatabase } from '../../database/database.js';
import type { ApplicationQuestionRow } from '../../types/index.js';

/**
 * Get all active application questions, ordered by sort_order.
 */
export function getActiveQuestions(): ApplicationQuestionRow[] {
    const db = getDatabase();
    return db
        .prepare('SELECT * FROM application_questions WHERE active = 1 ORDER BY sort_order ASC')
        .all() as ApplicationQuestionRow[];
}

/**
 * Get all application questions (including inactive), ordered by sort_order.
 */
export function getAllQuestions(): ApplicationQuestionRow[] {
    const db = getDatabase();
    return db
        .prepare('SELECT * FROM application_questions ORDER BY sort_order ASC')
        .all() as ApplicationQuestionRow[];
}

/**
 * Add a new application question.
 */
export function addQuestion(questionText: string): boolean {
    const db = getDatabase();
    try {
        const maxOrder = db
            .prepare('SELECT COALESCE(MAX(sort_order), 0) as max_order FROM application_questions')
            .get() as { max_order: number };
        db.prepare('INSERT INTO application_questions (question_text, sort_order) VALUES (?, ?)')
            .run(questionText, maxOrder.max_order + 1);
        return true;
    } catch {
        return false;
    }
}

/**
 * Remove an application question by ID (sets inactive).
 */
export function removeQuestion(questionId: number): boolean {
    const db = getDatabase();
    const result = db.prepare('UPDATE application_questions SET active = 0 WHERE id = ?').run(questionId);
    return result.changes > 0;
}

/**
 * Get a formatted string of all active questions for display.
 */
export function getQuestionsFormatted(): string {
    const questions = getActiveQuestions();
    if (questions.length === 0) return 'No application questions configured.';
    return questions
        .map((q, i) => `**${i + 1}.** (ID: ${q.id}) ${q.question_text}`)
        .join('\n');
}

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../src/database/db.js';
import type { ApplicationRow, ApplicationAnswerRow } from '../../src/types/index.js';

// Mock the logger
vi.mock('../../src/services/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('applications flow (integration)', () => {
  beforeEach(() => {
    closeDatabase();
    initDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
  });

  it('should create an application record', () => {
    const db = getDatabase();

    const result = db
      .prepare(
        'INSERT INTO applications (applicant_user_id, status, current_question_id) VALUES (?, ?, ?)',
      )
      .run('123456789', 'in_progress', null);

    expect(result.lastInsertRowid).toBeGreaterThan(0);

    const app = db
      .prepare('SELECT * FROM applications WHERE id = ?')
      .get(result.lastInsertRowid) as ApplicationRow;

    expect(app.applicant_user_id).toBe('123456789');
    expect(app.status).toBe('in_progress');
    expect(app.started_at).toBeTruthy();
    expect(app.submitted_at).toBeNull();
  });

  it('should store application answers linked to questions', () => {
    const db = getDatabase();

    // Add questions
    db.prepare('INSERT INTO application_questions (question, sort_order) VALUES (?, ?)').run(
      'What is your name?',
      1,
    );
    db.prepare('INSERT INTO application_questions (question, sort_order) VALUES (?, ?)').run(
      'What class?',
      2,
    );

    const q1 = db.prepare('SELECT id FROM application_questions WHERE sort_order = 1').get() as {
      id: number;
    };
    const q2 = db.prepare('SELECT id FROM application_questions WHERE sort_order = 2').get() as {
      id: number;
    };

    // Create application
    const appResult = db
      .prepare('INSERT INTO applications (applicant_user_id, status) VALUES (?, ?)')
      .run('123456789', 'in_progress');
    const appId = appResult.lastInsertRowid as number;

    // Store answers
    db.prepare(
      'INSERT INTO application_answers (application_id, question_id, answer) VALUES (?, ?, ?)',
    ).run(appId, q1.id, 'TestCharacter');
    db.prepare(
      'INSERT INTO application_answers (application_id, question_id, answer) VALUES (?, ?, ?)',
    ).run(appId, q2.id, 'Holy Paladin');

    const answers = db
      .prepare(
        `SELECT aa.*, aq.question
         FROM application_answers aa
         JOIN application_questions aq ON aa.question_id = aq.id
         WHERE aa.application_id = ?
         ORDER BY aq.sort_order`,
      )
      .all(appId) as Array<ApplicationAnswerRow & { question: string }>;

    expect(answers).toHaveLength(2);
    expect(answers[0].answer).toBe('TestCharacter');
    expect(answers[0].question).toBe('What is your name?');
    expect(answers[1].answer).toBe('Holy Paladin');
    expect(answers[1].question).toBe('What class?');
  });

  it('should transition application status correctly', () => {
    const db = getDatabase();

    // Create application
    const result = db
      .prepare('INSERT INTO applications (applicant_user_id, status) VALUES (?, ?)')
      .run('123456789', 'in_progress');
    const appId = result.lastInsertRowid as number;

    // Verify initial status
    let app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as ApplicationRow;
    expect(app.status).toBe('in_progress');

    // Transition to active (submitted)
    db.prepare(
      "UPDATE applications SET status = 'active', submitted_at = datetime('now') WHERE id = ?",
    ).run(appId);
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as ApplicationRow;
    expect(app.status).toBe('active');
    expect(app.submitted_at).toBeTruthy();

    // Transition to accepted
    db.prepare(
      "UPDATE applications SET status = 'accepted', resolved_at = datetime('now') WHERE id = ?",
    ).run(appId);
    app = db.prepare('SELECT * FROM applications WHERE id = ?').get(appId) as ApplicationRow;
    expect(app.status).toBe('accepted');
    expect(app.resolved_at).toBeTruthy();
  });

  it('should transition application to abandoned', () => {
    const db = getDatabase();

    const result = db
      .prepare('INSERT INTO applications (applicant_user_id, status) VALUES (?, ?)')
      .run('123456789', 'in_progress');
    const appId = result.lastInsertRowid as number;

    db.prepare("UPDATE applications SET status = 'abandoned' WHERE id = ?").run(appId);

    const app = db
      .prepare('SELECT * FROM applications WHERE id = ?')
      .get(appId) as ApplicationRow;
    expect(app.status).toBe('abandoned');
  });

  it('should enforce foreign key between answers and questions', () => {
    const db = getDatabase();

    const appResult = db
      .prepare('INSERT INTO applications (applicant_user_id, status) VALUES (?, ?)')
      .run('123456789', 'in_progress');
    const appId = appResult.lastInsertRowid as number;

    // Try to insert answer with non-existent question_id
    expect(() => {
      db.prepare(
        'INSERT INTO application_answers (application_id, question_id, answer) VALUES (?, ?, ?)',
      ).run(appId, 99999, 'Invalid answer');
    }).toThrow();
  });

  it('should store and retrieve character_name', () => {
    const db = getDatabase();

    const result = db
      .prepare(
        'INSERT INTO applications (applicant_user_id, status, character_name) VALUES (?, ?, ?)',
      )
      .run('123456789', 'in_progress', 'TestPaladin');

    const app = db
      .prepare('SELECT * FROM applications WHERE id = ?')
      .get(result.lastInsertRowid) as ApplicationRow;

    expect(app.character_name).toBe('TestPaladin');
  });

  it('should find in_progress applications by user ID', () => {
    const db = getDatabase();

    // Create multiple applications for the same user
    db.prepare('INSERT INTO applications (applicant_user_id, status) VALUES (?, ?)').run(
      '123456789',
      'abandoned',
    );
    db.prepare('INSERT INTO applications (applicant_user_id, status) VALUES (?, ?)').run(
      '123456789',
      'in_progress',
    );
    db.prepare('INSERT INTO applications (applicant_user_id, status) VALUES (?, ?)').run(
      '987654321',
      'in_progress',
    );

    const userApps = db
      .prepare('SELECT * FROM applications WHERE applicant_user_id = ? AND status = ?')
      .all('123456789', 'in_progress') as ApplicationRow[];

    expect(userApps).toHaveLength(1);
    expect(userApps[0].applicant_user_id).toBe('123456789');
    expect(userApps[0].status).toBe('in_progress');
  });
});

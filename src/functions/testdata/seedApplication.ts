import type Database from 'better-sqlite3';

const DEFAULT_QUESTIONS = [
  { question: 'What is your character name, realm, and class/spec?', sort_order: 1 },
  { question: 'Tell us about your raiding experience and previous guilds.', sort_order: 2 },
  { question: 'What logs do you have available? Please provide a WarcraftLogs link.', sort_order: 3 },
  { question: 'What is your raid availability and can you commit to our schedule?', sort_order: 4 },
  { question: 'Is there anything else you would like to tell us?', sort_order: 5 },
];

const MOCK_ANSWERS = [
  'Testcharacter, Silvermoon-EU, Warrior (Arms)',
  'I have been raiding since Wrath of the Lich King. Most recently I was in <Eternal Radiance> on Silvermoon where we achieved Cutting Edge in the previous tier.',
  'https://www.warcraftlogs.com/character/eu/silvermoon/testcharacter — 95th percentile parses across the board.',
  'Yes, Wednesday and Sunday evenings suit me perfectly. I have no foreseeable schedule conflicts.',
  'I am a quick learner, bring my own consumables, and always come prepared with boss research done in advance.',
];

export interface SeedApplicationResult {
  applicationId: number;
  questionCount: number;
}

/**
 * Seeds 1 mock application with answers and 2 votes.
 * Inserts 5 default questions if none exist.
 * Returns the new application ID.
 */
export function seedApplication(db: Database.Database): SeedApplicationResult {
  const tx = db.transaction((): SeedApplicationResult => {
    // Ensure questions exist
    const existing = db.prepare('SELECT COUNT(*) as count FROM application_questions').get() as { count: number };
    if (existing.count === 0) {
      const insertQ = db.prepare('INSERT INTO application_questions (question, sort_order) VALUES (@question, @sort_order)');
      for (const q of DEFAULT_QUESTIONS) {
        insertQ.run(q);
      }
    }

    const questions = db.prepare('SELECT id, question, sort_order FROM application_questions ORDER BY sort_order').all() as Array<{ id: number; question: string; sort_order: number }>;

    // Insert application
    const appResult = db.prepare(`
      INSERT INTO applications (character_name, applicant_user_id, status, submitted_at, started_at)
      VALUES (?, ?, 'submitted', datetime('now'), datetime('now', '-10 minutes'))
    `).run('Testcharacter', 'mock-user-id-001');

    const applicationId = appResult.lastInsertRowid as number;

    // Insert answers (one per question, cycling through mock answers)
    const insertAnswer = db.prepare('INSERT INTO application_answers (application_id, question_id, answer) VALUES (?, ?, ?)');
    for (let i = 0; i < questions.length; i++) {
      const answer = MOCK_ANSWERS[i % MOCK_ANSWERS.length];
      insertAnswer.run(applicationId, questions[i].id, answer);
    }

    // Insert 2 votes
    db.prepare('INSERT INTO application_votes (application_id, user_id, vote_type) VALUES (?, ?, ?)').run(applicationId, 'mock-officer-id-001', 'for');
    db.prepare('INSERT INTO application_votes (application_id, user_id, vote_type) VALUES (?, ?, ?)').run(applicationId, 'mock-officer-id-002', 'neutral');

    return { applicationId, questionCount: questions.length };
  });

  return tx();
}

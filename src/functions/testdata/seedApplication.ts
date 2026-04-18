import type Database from 'better-sqlite3';
import { seedApplicationQuestions } from './seedApplicationQuestions.js';

const MOCK_ANSWERS = [
  'Warrior (Arms)',
  'https://raider.io/characters/eu/silvermoon/testcharacter',
  "I'm 28, based in the UK, work in software, and enjoy hiking on weekends.",
  "Found you via Raider.IO recruitment listings. A friend who used to raid with you (Someguy) spoke highly of the guild's atmosphere.",
  'Cutting Edge Mythic Queen Ansurek (Nerub-ar Palace), 6/8M Aberrus while current. Logs: https://www.warcraftlogs.com/character/eu/silvermoon/testcharacter',
  "I've pushed 3.2k+ M+ rating this season and have heroic logs sitting at 90th+ percentile on most bosses.",
  'Yes, both evenings work reliably. No known conflicts with the raid schedule.',
  'I can swap to Protection for off-tank duties and have a geared resto druid alt (mythic logs available on request).',
  "Thanks for considering my application — I'm keen to contribute and learn from the team.",
];

export type SeededApplicationStatus = 'in_progress' | 'submitted' | 'accepted' | 'rejected' | 'abandoned';

export interface SeedApplicationOptions {
  characterName?: string;
  userId?: string;
  status?: SeededApplicationStatus;
  /** Number of answers to insert. Defaults to all questions. */
  answerCount?: number;
  /** Whether to insert the 2 mock votes. Defaults to true for `submitted`/`accepted`/`rejected`; false for `in_progress`/`abandoned`. */
  includeVotes?: boolean;
}

export interface SeedApplicationResult {
  applicationId: number;
  questionCount: number;
  answersInserted: number;
  votesInserted: number;
}

/**
 * Seeds 1 mock application with answers and (optionally) votes.
 * Delegates to seedApplicationQuestions to ensure the 9 default questions exist.
 * Returns the new application ID.
 */
export function seedApplication(
  db: Database.Database,
  options: SeedApplicationOptions = {},
): SeedApplicationResult {
  const characterName = options.characterName ?? 'Testcharacter';
  const userId = options.userId ?? 'mock-user-id-001';
  const status = options.status ?? 'submitted';
  const includeVotes = options.includeVotes ?? (status !== 'in_progress' && status !== 'abandoned');

  const tx = db.transaction((): SeedApplicationResult => {
    seedApplicationQuestions(db);

    const questions = db.prepare('SELECT id, question, sort_order FROM application_questions ORDER BY sort_order').all() as Array<{ id: number; question: string; sort_order: number }>;

    const answerCount = Math.min(options.answerCount ?? questions.length, questions.length);

    const submittedAtClause = status === 'in_progress' ? 'NULL' : "datetime('now')";
    const startedAtClause = "datetime('now', '-10 minutes')";

    const appResult = db.prepare(`
      INSERT INTO applications (character_name, applicant_user_id, status, submitted_at, started_at)
      VALUES (?, ?, ?, ${submittedAtClause}, ${startedAtClause})
    `).run(characterName, userId, status);

    const applicationId = appResult.lastInsertRowid as number;

    const insertAnswer = db.prepare('INSERT INTO application_answers (application_id, question_id, answer) VALUES (?, ?, ?)');
    for (let i = 0; i < answerCount; i++) {
      const answer = MOCK_ANSWERS[i % MOCK_ANSWERS.length];
      insertAnswer.run(applicationId, questions[i].id, answer);
    }

    let votesInserted = 0;
    if (includeVotes) {
      db.prepare('INSERT INTO application_votes (application_id, user_id, vote_type) VALUES (?, ?, ?)').run(applicationId, 'mock-officer-id-001', 'for');
      db.prepare('INSERT INTO application_votes (application_id, user_id, vote_type) VALUES (?, ?, ?)').run(applicationId, 'mock-officer-id-002', 'neutral');
      votesInserted = 2;
    }

    return {
      applicationId,
      questionCount: questions.length,
      answersInserted: answerCount,
      votesInserted,
    };
  });

  return tx();
}

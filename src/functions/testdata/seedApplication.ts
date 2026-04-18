import type Database from 'better-sqlite3';

const DEFAULT_QUESTIONS = [
  { question: "What class and (if you're a multi-role class) spec are you applying as?", sort_order: 1 },
  { question: 'Please link your Raider.IO profile of the character you wish to apply with', sort_order: 2 },
  { question: 'Tell us about yourself, this should include your age, location and any other aspects about your life that you are willing to share', sort_order: 3 },
  { question: 'How did you find us and what made you want to apply to SeriouslyCasual? (Include any known SeriouslyCasual members here)', sort_order: 4 },
  { question: 'What is your current and past experience in raiding at the highest level? This should only address MYTHIC progression obtained whilst the content was current! Please include logs where applicable and available', sort_order: 5 },
  { question: 'We aim to achieve Cutting Edge in every raid tier. If you have not done this before, please include anything here that showcases your in game ability to a similar level (e.g. mythic plus logs, PvP achievements, notable heroic logs or any other challenging content)', sort_order: 6 },
  { question: 'Could you commit to both a Wednesday and Sunday raid each week, and is there anything that might interfere with our raid schedule?', sort_order: 7 },
  { question: "Do you have an offspec or any other classes you'd be able to play and willing to raid as? If so please provide logs (Mythic logs preferred)", sort_order: 8 },
  { question: 'Would you like to include any further information to support your application? This is the final question after which you can submit all answers provided.', sort_order: 9 },
];

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

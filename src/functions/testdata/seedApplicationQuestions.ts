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

export interface SeedApplicationQuestionsResult {
  inserted: number;
}

/**
 * Ensures the 9 default application questions exist. Idempotent: only inserts when the table is empty.
 */
export function seedApplicationQuestions(db: Database.Database): SeedApplicationQuestionsResult {
  const existing = db.prepare('SELECT COUNT(*) as count FROM application_questions').get() as { count: number };
  if (existing.count > 0) {
    return { inserted: 0 };
  }

  const insertQ = db.prepare('INSERT INTO application_questions (question, sort_order) VALUES (@question, @sort_order)');
  const tx = db.transaction((): number => {
    for (const q of DEFAULT_QUESTIONS) {
      insertQ.run(q);
    }
    return DEFAULT_QUESTIONS.length;
  });

  return { inserted: tx() };
}

export { DEFAULT_QUESTIONS };

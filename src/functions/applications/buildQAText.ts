import type { User } from 'discord.js';

export interface AnswerWithQuestion {
  question: string;
  answer: string;
}

/**
 * Builds the Q&A body posted to the application channel and forum thread.
 * Shared by submitApplication (real applicant) and the testdata seed.
 */
export function buildQAText(
  answers: AnswerWithQuestion[],
  user: User,
  characterName: string,
): string {
  let text = `**Application: ${characterName}**\n`;
  text += `Applicant: ${user} (${user.tag})\n`;
  text += `Date: ${new Date().toISOString().split('T')[0]}\n\n`;

  for (let i = 0; i < answers.length; i++) {
    text += `**${i + 1}. ${answers[i].question}**\n${answers[i].answer}\n\n`;
  }

  return text;
}

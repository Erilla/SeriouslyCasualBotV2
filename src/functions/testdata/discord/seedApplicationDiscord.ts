import type { Client, User } from 'discord.js';
import type Database from 'better-sqlite3';
import { logger } from '../../../services/logger.js';
import { config } from '../../../config.js';
import { seedApplication, type SeedApplicationOptions } from '../seedApplication.js';
import { createForumPost } from '../../applications/createForumPost.js';

export interface SeedApplicationDiscordResult {
  applicationId: number;
  forumPostId: string | null;
  threadId: string | null;
  skippedReason?: string;
}

interface AnswerWithQuestion {
  question: string;
  answer: string;
}

function buildQAText(answers: AnswerWithQuestion[], user: User, characterName: string): string {
  let text = `**Application: ${characterName}**\n`;
  text += `Applicant: ${user} (${user.tag})\n`;
  text += `Date: ${new Date().toISOString().split('T')[0]}\n\n`;
  for (let i = 0; i < answers.length; i++) {
    text += `**${i + 1}. ${answers[i].question}**\n${answers[i].answer}\n\n`;
  }
  return text;
}

/**
 * DB-only seedApplication + creates the applications forum post (Active tag + voting buttons + accept/reject buttons).
 * The forum channel is auto-created if not configured.
 * Mock "applicant" is the bot user itself.
 */
export async function seedApplicationDiscord(
  client: Client,
  db: Database.Database,
  options: SeedApplicationOptions = {},
): Promise<SeedApplicationDiscordResult> {
  const seedResult = seedApplication(db, options);

  const guild = client.guilds.cache.get(config.guildId);
  if (!guild) {
    return {
      applicationId: seedResult.applicationId,
      forumPostId: null,
      threadId: null,
      skippedReason: 'guild not found in client cache',
    };
  }

  if (!client.user) {
    return {
      applicationId: seedResult.applicationId,
      forumPostId: null,
      threadId: null,
      skippedReason: 'bot user not available',
    };
  }

  const characterName = options.characterName ?? 'Testcharacter';

  const answers = db
    .prepare(
      `SELECT aq.question, aa.answer
       FROM application_answers aa
       JOIN application_questions aq ON aa.question_id = aq.id
       WHERE aa.application_id = ?
       ORDER BY aq.sort_order`,
    )
    .all(seedResult.applicationId) as AnswerWithQuestion[];

  const qaText = buildQAText(answers, client.user as unknown as User, characterName);

  try {
    const { forumPost, threadId } = await createForumPost(
      guild,
      characterName,
      client.user as unknown as User,
      qaText,
      seedResult.applicationId,
    );

    if (forumPost) {
      db.prepare('UPDATE applications SET forum_post_id = ?, thread_id = ? WHERE id = ?').run(
        forumPost.id,
        threadId,
        seedResult.applicationId,
      );
    }

    return {
      applicationId: seedResult.applicationId,
      forumPostId: forumPost?.id ?? null,
      threadId,
    };
  } catch (error) {
    logger.error('TestData', 'Failed to create forum post for seeded application', error as Error);
    return {
      applicationId: seedResult.applicationId,
      forumPostId: null,
      threadId: null,
      skippedReason: `forum post failed: ${(error as Error).message}`,
    };
  }
}

import type { Client } from 'discord.js';
import type Database from 'better-sqlite3';
import { logger } from '../../../services/logger.js';
import { config } from '../../../config.js';
import {
  seedApplication,
  SEED_CHARACTER,
  type SeedApplicationOptions,
} from '../seedApplication.js';
import { createForumPost } from '../../applications/createForumPost.js';
import { collectRaiderIoCharacters } from '../../applications/raiderIoName.js';
import { startIntelJob } from '../../applications/intel/placeholders.js';
import { buildQAText, type AnswerWithQuestion } from '../../applications/buildQAText.js';

export interface SeedApplicationDiscordResult {
  applicationId: number;
  forumPostId: string | null;
  threadId: string | null;
  skippedReason?: string;
}

/**
 * DB-only seedApplication + creates the applications forum post (Active tag + voting buttons + accept/reject buttons).
 * The forum channel is auto-created if not configured.
 * Mock "applicant" is the bot user itself (ClientUser is a structural subtype of User).
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

  const characterName = options.characterName ?? SEED_CHARACTER.name;

  const answers = db
    .prepare(
      `SELECT aq.question, aa.answer
       FROM application_answers aa
       JOIN application_questions aq ON aa.question_id = aq.id
       WHERE aa.application_id = ?
       ORDER BY aq.sort_order`,
    )
    .all(seedResult.applicationId) as AnswerWithQuestion[];

  const qaText = buildQAText(answers, client.user, characterName);

  // Parsed once and used for both decisions, exactly as submitApplication does:
  // it gates the intel placeholders and provides the sweep's characters.
  const named = collectRaiderIoCharacters(answers);

  try {
    const { forumPost, threadId, altsMessageId, guildsMessageId, logsMessageId } =
      await createForumPost(
        guild,
        characterName,
        client.user,
        qaText,
        seedResult.applicationId,
        named,
      );

    db.prepare('UPDATE applications SET forum_post_id = ?, thread_id = ? WHERE id = ?').run(
      forumPost.id,
      threadId,
      seedResult.applicationId,
    );

    // Queue the sweep, like a real submission. Without this the seeder reserved
    // the three placeholders and nothing ever edited them, which is precisely how
    // a seeded application ended up stuck on "searching…" indefinitely. Failure
    // here must not fail the seed, so it is logged and swallowed.
    if (named.length > 0) {
      try {
        const jobId = startIntelJob({
          applicationId: seedResult.applicationId,
          targetChannelId: threadId,
          characters: named,
          applicantDiscord: client.user.username,
          altsMessageId,
          guildsMessageId,
          logsMessageId,
        });
        logger.info(
          'TestData',
          `Queued intel job #${jobId} for seeded application #${seedResult.applicationId}`,
        );
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        logger.warn(
          'TestData',
          `Failed to queue intel job for seeded application: ${error.message}`,
        );
      }
    }

    return {
      applicationId: seedResult.applicationId,
      forumPostId: forumPost.id,
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

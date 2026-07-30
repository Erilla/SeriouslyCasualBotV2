import {
  type Client,
  type User,
  type TextChannel,
  type Guild,
  ChannelType,
  OverwriteType,
  PermissionFlagsBits,
} from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { getOrCreateChannel } from '../channels.js';
import { logger } from '../../services/logger.js';
import { config } from '../../config.js';
import { createForumPost } from './createForumPost.js';
import { splitMessage } from './splitMessage.js';
import { buildQAText } from './buildQAText.js';
import { deriveCharacterNameFromAnswers } from './raiderIoName.js';
import { linkCharacterIdentity } from '../raids/linkCharacterIdentity.js';
import { getOverlords } from '../raids/overlords.js';
import { buildOverlordNotification } from './overlordNotification.js';
import { refreshPendingApplicationCategory } from './applicationLogCategory.js';
import type { ApplicationRow } from '../../types/index.js';

interface AnswerWithQuestion {
  question: string;
  answer: string;
  sort_order: number;
}

/**
 * Submit a confirmed application: create text channel + forum post, update DB, notify overlords.
 */
export async function submitApplication(
  client: Client,
  applicationId: number,
  user: User,
): Promise<void> {
  const db = getDatabase();

  const application = db.prepare('SELECT * FROM applications WHERE id = ?').get(applicationId) as
    | ApplicationRow
    | undefined;

  if (!application) {
    throw new Error(`Application #${applicationId} not found`);
  }

  // Get answers with questions
  const answers = db
    .prepare(
      `SELECT aq.question, aa.answer, aq.sort_order
       FROM application_answers aa
       JOIN application_questions aq ON aa.question_id = aq.id
       WHERE aa.application_id = ?
       ORDER BY aq.sort_order`,
    )
    .all(applicationId) as AnswerWithQuestion[];

  if (answers.length === 0) {
    throw new Error(`Application #${applicationId} has no answers`);
  }

  const guild = client.guilds.cache.get(config.guildId);
  if (!guild) {
    throw new Error('Guild not found');
  }

  // Prefer the character name parsed from the applicant's Raider.IO URL; fall
  // back to the name seeded at creation (their Discord display name).
  const parsedCharacterName = deriveCharacterNameFromAnswers(answers);
  const characterName = parsedCharacterName || application.character_name || user.displayName;
  const channelName = `app-${characterName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .substring(0, 90)}`;

  // Build the Q&A text
  const qaText = buildQAText(answers, user, characterName);

  // Step 1: Create text channel
  let channel: TextChannel;
  try {
    channel = await createApplicationChannel(guild, channelName, user, qaText);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error(
      'Applications',
      `Failed to create application channel for #${applicationId}: ${error.message}`,
      error,
    );
    throw new Error(`Failed to create application channel: ${error.message}`, { cause: err });
  }

  // Step 2: Create forum post
  let forumPost: { id: string } | null = null;
  let threadId: string | null = null;
  try {
    const result = await createForumPost(guild, characterName, user, qaText, applicationId);
    forumPost = result.forumPost;
    threadId = result.threadId;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error(
      'Applications',
      `Failed to create forum post for #${applicationId}: ${error.message}`,
      error,
    );
    // Don't throw here - the text channel was already created, so update the record with what we have
  }

  // Step 3: Update application record
  try {
    db.prepare(
      `UPDATE applications
       SET status = 'active',
           character_name = ?,
           channel_id = ?,
           forum_post_id = ?,
           thread_id = ?,
           submitted_at = datetime('now')
       WHERE id = ?`,
    ).run(characterName, channel.id, forumPost?.id ?? null, threadId ?? null, applicationId);
    await refreshPendingApplicationCategory(guild);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error(
      'Applications',
      `Failed to update application #${applicationId} record: ${error.message}`,
      error,
    );
    throw new Error(`Failed to update application record: ${error.message}`, { cause: err });
  }

  // Step 3b: Record the character -> Discord identity link so a future roster
  // sync auto-links them once they're in the guild. Only when we have a real
  // in-game name from Raider.IO (not the Discord-name fallback). Non-fatal.
  if (parsedCharacterName) {
    try {
      linkCharacterIdentity(parsedCharacterName, user.id);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.warn(
        'Applications',
        `Failed to link character identity for #${applicationId}: ${error.message}`,
      );
    }
  }

  // Step 4: Notify overlords in the forum thread (non-fatal if it fails)
  if (threadId) {
    try {
      await notifyOverlords(guild, threadId, characterName, user);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.warn(
        'Applications',
        `Failed to notify overlords for application #${applicationId}: ${error.message}`,
      );
    }
  }

  logger.info(
    'Applications',
    `Application #${applicationId} submitted by ${user.tag} (${characterName}) - channel: ${channel.id}`,
  );
}

// ─── Channel Creation ─────────────────────────────────────────

export interface ApplicationChannelOverwrite {
  id: string;
  type: OverwriteType;
  allow?: bigint[];
  deny?: bigint[];
}

/**
 * Build the permission overwrites for an application channel.
 *
 * Every overwrite carries an explicit `type` (Role/Member). This matters:
 * when `type` is omitted, discord.js's PermissionOverwrites.resolve falls back
 * to `guild.roles.resolve(id) ?? client.users.resolve(id)` — a CACHE-only
 * lookup — and throws "Supplied parameter is not a cached User or Role" for any
 * id it can't find (an overlord who left the guild, a stale officer role, or
 * simply a cold user cache after a restart). Setting the type takes the fast
 * path and never touches the cache.
 */
export function buildApplicationChannelOverwrites(
  guildId: string,
  applicantId: string,
  overlordUserIds: string[],
  officerRoleId: string | null,
): ApplicationChannelOverwrite[] {
  const overwrites: ApplicationChannelOverwrite[] = [
    {
      id: guildId, // @everyone
      type: OverwriteType.Role,
      deny: [PermissionFlagsBits.ViewChannel],
    },
    {
      id: applicantId,
      type: OverwriteType.Member,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
    },
    ...overlordUserIds.map((userId) => ({
      id: userId,
      type: OverwriteType.Member,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
    })),
  ];

  if (officerRoleId) {
    overwrites.push({
      id: officerRoleId,
      type: OverwriteType.Role,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
    });
  }

  // Discord rejects a channel with two overwrites for the same id (e.g. an
  // overlord who is also the applicant). Keep the first occurrence of each id.
  const seen = new Set<string>();
  return overwrites.filter((ow) => {
    if (seen.has(ow.id)) return false;
    seen.add(ow.id);
    return true;
  });
}

async function createApplicationChannel(
  guild: Guild,
  channelName: string,
  applicant: User,
  qaText: string,
): Promise<TextChannel> {
  // Get or create applications category (the only category the bot will auto-create,
  // by convention; not enforced in the helper)
  let categoryId: string;
  try {
    const category = await getOrCreateChannel(guild, {
      name: 'Applications',
      type: ChannelType.GuildCategory,
      categoryName: null,
      configKey: 'applications_category_id',
    });
    categoryId = category.id;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    throw new Error(
      `Failed to create Applications category (does the bot have Manage Channels permission?): ${error.message}`,
      { cause: err },
    );
  }

  // Get overlords for permissions
  const overlords = getOverlords();

  const permissionOverwrites = buildApplicationChannelOverwrites(
    guild.id,
    applicant.id,
    overlords.map((o) => o.user_id),
    config.officerRoleId,
  );

  let channel: TextChannel;
  try {
    channel = (await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: categoryId,
      permissionOverwrites,
    })) as TextChannel;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    throw new Error(
      `Failed to create text channel "${channelName}" (does the bot have Manage Channels permission?): ${error.message}`,
      { cause: err },
    );
  }

  // Post Q&A (split if > 2000 chars)
  const messages = splitMessage(qaText);
  for (const msg of messages) {
    await channel.send(msg);
  }

  return channel;
}

// ─── Overlord Notification ────────────────────────────────────

async function notifyOverlords(
  guild: Guild,
  threadId: string,
  characterName: string,
  applicant: User,
): Promise<void> {
  const overlords = getOverlords();
  if (overlords.length === 0) return;

  const overlordIds = overlords.map((o) => o.user_id);
  const notification = buildOverlordNotification(overlordIds, characterName, applicant.tag);

  const thread = guild.channels.cache.get(threadId);
  if (!thread || !thread.isThread()) {
    // Try to fetch it
    try {
      const fetchedThread = await guild.channels.fetch(threadId);
      if (!fetchedThread || !fetchedThread.isThread()) return;

      await fetchedThread.send(notification);
    } catch {
      logger.warn('Applications', `Failed to notify overlords in thread ${threadId}`);
    }
    return;
  }

  await (thread as unknown as TextChannel).send(notification);
}

import {
  type Client,
  type User,
  type TextChannel,
  type Guild,
  ChannelType,
  PermissionFlagsBits,
} from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';
import { config } from '../../config.js';
import { createForumPost } from './createForumPost.js';
import { splitMessage } from './splitMessage.js';
import { getOverlords } from '../raids/overlords.js';
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

  const application = db
    .prepare('SELECT * FROM applications WHERE id = ?')
    .get(applicationId) as ApplicationRow | undefined;

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

  const characterName = application.character_name || user.displayName;
  const channelName = `app-${characterName.toLowerCase().replace(/[^a-z0-9-]/g, '-').substring(0, 90)}`;

  // Build the Q&A text
  const qaText = buildQAText(answers, user, characterName);

  // Step 1: Create text channel
  let channel: TextChannel;
  try {
    channel = await createApplicationChannel(guild, channelName, user, qaText);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error('Applications', `Failed to create application channel for #${applicationId}: ${error.message}`, error);
    throw new Error(`Failed to create application channel: ${error.message}`);
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
    logger.error('Applications', `Failed to create forum post for #${applicationId}: ${error.message}`, error);
    // Don't throw here - the text channel was already created, so update the record with what we have
  }

  // Step 3: Update application record
  try {
    db.prepare(
      `UPDATE applications
       SET status = 'active',
           channel_id = ?,
           forum_post_id = ?,
           thread_id = ?,
           submitted_at = datetime('now')
       WHERE id = ?`,
    ).run(
      channel.id,
      forumPost?.id ?? null,
      threadId ?? null,
      applicationId,
    );
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error('Applications', `Failed to update application #${applicationId} record: ${error.message}`, error);
    throw new Error(`Failed to update application record: ${error.message}`);
  }

  // Step 4: Notify overlords in the forum thread (non-fatal if it fails)
  if (threadId) {
    try {
      await notifyOverlords(guild, threadId, characterName, user);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.warn('Applications', `Failed to notify overlords for application #${applicationId}: ${error.message}`);
    }
  }

  logger.info(
    'Applications',
    `Application #${applicationId} submitted by ${user.tag} (${characterName}) - channel: ${channel.id}`,
  );
}

// ─── Q&A Text Builder ─────────────────────────────────────────

function buildQAText(answers: AnswerWithQuestion[], user: User, characterName: string): string {
  let text = `**Application: ${characterName}**\n`;
  text += `Applicant: ${user} (${user.tag})\n`;
  text += `Date: ${new Date().toISOString().split('T')[0]}\n\n`;

  for (let i = 0; i < answers.length; i++) {
    text += `**${i + 1}. ${answers[i].question}**\n${answers[i].answer}\n\n`;
  }

  return text;
}

// ─── Channel Creation ─────────────────────────────────────────

async function createApplicationChannel(
  guild: Guild,
  channelName: string,
  applicant: User,
  qaText: string,
): Promise<TextChannel> {
  const db = getDatabase();

  // Get or create applications category
  let categoryId = (
    db.prepare('SELECT value FROM config WHERE key = ?').get('applications_category_id') as
      | { value: string }
      | undefined
  )?.value;

  if (categoryId) {
    // Verify category still exists (it may have been deleted)
    try {
      const existing = guild.channels.cache.get(categoryId) ?? await guild.channels.fetch(categoryId).catch(() => null);
      if (!existing || existing.type !== ChannelType.GuildCategory) {
        logger.info('Applications', `Applications category ${categoryId} no longer exists, creating a new one`);
        categoryId = undefined;
      }
    } catch {
      categoryId = undefined;
    }
  }

  if (!categoryId) {
    try {
      const category = await guild.channels.create({
        name: 'Applications',
        type: ChannelType.GuildCategory,
      });
      categoryId = category.id;
      db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(
        'applications_category_id',
        categoryId,
      );
      logger.info('Applications', `Created applications category: ${categoryId}`);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new Error(`Failed to create Applications category (does the bot have Manage Channels permission?): ${error.message}`);
    }
  }

  // Get overlords for permissions
  const overlords = getOverlords();

  // Build permission overwrites
  const permissionOverwrites = [
    {
      id: guild.id, // @everyone
      deny: [PermissionFlagsBits.ViewChannel],
    },
    {
      id: applicant.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
    },
    ...overlords.map((o) => ({
      id: o.user_id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
    })),
  ];

  // Also add officer role permission
  const officerRoleId = config.officerRoleId;
  if (officerRoleId) {
    permissionOverwrites.push({
      id: officerRoleId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
    });
  }

  let channel: TextChannel;
  try {
    channel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: categoryId,
      permissionOverwrites,
    }) as TextChannel;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    throw new Error(`Failed to create text channel "${channelName}" (does the bot have Manage Channels permission?): ${error.message}`);
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

  const thread = guild.channels.cache.get(threadId);
  if (!thread || !thread.isThread()) {
    // Try to fetch it
    try {
      const fetchedThread = await guild.channels.fetch(threadId);
      if (!fetchedThread || !fetchedThread.isThread()) return;

      const mentions = overlords.map((o) => `<@${o.user_id}>`).join(' ');
      await fetchedThread.send(
        `${mentions}\nNew application from **${characterName}** (${applicant.tag}). Please review!`,
      );
    } catch {
      logger.warn('Applications', `Failed to notify overlords in thread ${threadId}`);
    }
    return;
  }

  const mentions = overlords.map((o) => `<@${o.user_id}>`).join(' ');
  await (thread as unknown as TextChannel).send(
    `${mentions}\nNew application from **${characterName}** (${applicant.tag}). Please review!`,
  );
}


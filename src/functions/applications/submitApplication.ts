import {
  type Client,
  type User,
  type TextChannel,
  type ForumChannel,
  type CategoryChannel,
  type Guild,
  ChannelType,
  PermissionFlagsBits,
  ThreadAutoArchiveDuration,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';
import { config } from '../../config.js';
import { generateVotingEmbed } from './generateVotingEmbed.js';
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

  const guild = client.guilds.cache.get(config.guildId);
  if (!guild) {
    throw new Error('Guild not found');
  }

  const characterName = application.character_name || user.displayName;
  const channelName = `app-${characterName.toLowerCase().replace(/[^a-z0-9-]/g, '-').substring(0, 90)}`;

  // Build the Q&A text
  const qaText = buildQAText(answers, user, characterName);

  // Create text channel
  const channel = await createApplicationChannel(guild, channelName, user, qaText);

  // Create forum post
  const { forumPost, threadId } = await createForumPost(guild, characterName, user, qaText, applicationId);

  // Update application record
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

  // Notify overlords in the forum thread
  if (threadId) {
    await notifyOverlords(guild, threadId, characterName, user);
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
    // Verify category still exists
    const existing = guild.channels.cache.get(categoryId);
    if (!existing || existing.type !== ChannelType.GuildCategory) {
      categoryId = undefined;
    }
  }

  if (!categoryId) {
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

  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: categoryId,
    permissionOverwrites,
  });

  // Post Q&A (split if > 2000 chars)
  const messages = splitMessage(qaText);
  for (const msg of messages) {
    await channel.send(msg);
  }

  return channel;
}

// ─── Forum Post Creation ──────────────────────────────────────

async function createForumPost(
  guild: Guild,
  characterName: string,
  applicant: User,
  qaText: string,
  applicationId: number,
): Promise<{ forumPost: { id: string } | null; threadId: string | null }> {
  const db = getDatabase();

  // Get or create application-log forum
  let forumId = (
    db.prepare('SELECT value FROM config WHERE key = ?').get('application_log_forum_id') as
      | { value: string }
      | undefined
  )?.value;

  let forum: ForumChannel | null = null;

  if (forumId) {
    const existing = guild.channels.cache.get(forumId);
    if (existing && existing.type === ChannelType.GuildForum) {
      forum = existing as ForumChannel;
    }
  }

  if (!forum) {
    forum = await guild.channels.create({
      name: 'application-log',
      type: ChannelType.GuildForum,
    });
    forumId = forum.id;
    db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(
      'application_log_forum_id',
      forumId,
    );
    logger.info('Applications', `Created application-log forum: ${forumId}`);
  }

  // Ensure tags exist (Active, Accepted, Rejected)
  const existingTags = forum.availableTags;
  const requiredTags = ['Active', 'Accepted', 'Rejected'];
  const missingTags = requiredTags.filter(
    (tag) => !existingTags.some((t) => t.name === tag),
  );

  if (missingTags.length > 0) {
    const newTags = [
      ...existingTags,
      ...missingTags.map((name) => ({ name })),
    ];
    await forum.setAvailableTags(newTags);
    // Re-fetch to get the updated tag IDs
    const updatedForum = (await forum.fetch()) as ForumChannel;
    forum = updatedForum;
  }

  // Find Active tag
  const activeTag = forum.availableTags.find((t) => t.name === 'Active');

  // Split Q&A for the first message
  const messages = splitMessage(qaText);

  // Create the forum thread
  const thread = await forum.threads.create({
    name: characterName,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
    message: { content: messages[0] },
    appliedTags: activeTag ? [activeTag.id] : [],
  });

  // Send remaining Q&A messages if split
  for (let i = 1; i < messages.length; i++) {
    await thread.send(messages[i]);
  }

  // Voting embed with buttons
  const votingData = generateVotingEmbed(applicationId);
  await thread.send(votingData);

  // Accept/Reject buttons
  const decisionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`application:accept:${applicationId}`)
      .setLabel('Accept')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`application:reject:${applicationId}`)
      .setLabel('Reject')
      .setStyle(ButtonStyle.Danger),
  );
  await thread.send({ components: [decisionRow] });

  return { forumPost: { id: forum.id }, threadId: thread.id };
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

// ─── Helpers ──────────────────────────────────────────────────

function splitMessage(content: string, maxLength = 2000): string[] {
  if (content.length <= maxLength) return [content];

  const parts: string[] = [];
  let remaining = content;

  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt === -1 || splitAt < maxLength / 2) {
      splitAt = maxLength;
    }
    parts.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt).trimStart();
  }

  if (remaining.length > 0) {
    parts.push(remaining);
  }

  return parts;
}

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
import { deriveCharacterNameFromAnswers, collectRaiderIoCharacters } from './raiderIoName.js';
import { startIntelJob } from './intel/placeholders.js';
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

export type SubmitApplicationResult = 'submitted' | 'already_submitted';

/**
 * How long one submission attempt may hold the claim before another may take it.
 *
 * Long enough that a genuinely in-flight attempt (several Discord round-trips)
 * is never displaced, short enough that an applicant whose submission died with
 * the process isn't left stuck for long.
 */
export const SUBMISSION_LEASE_MINUTES = 10;

/**
 * Submit a confirmed application: create text channel + forum post, update DB, notify overlords.
 *
 * Returns 'already_submitted' — without touching Discord — when the application
 * has already been through here. The summary DM's Confirm/Edit/Cancel buttons use
 * static custom IDs and are never removed by Discord, so a click can arrive at any
 * time, including days after submission (see resumeSessions for why they're
 * deliberately persistent). Without this guard a second click re-ran the whole
 * submission: a second app-* channel, a second forum thread, a second intel job,
 * and an UPDATE that repointed the row at the new pair — orphaning the original
 * channel and thread officers were already reviewing in.
 */
export async function submitApplication(
  client: Client,
  applicationId: number,
  user: User,
): Promise<SubmitApplicationResult> {
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

  // Claim the application before any Discord work. A conditional UPDATE is the
  // guard rather than a read-then-check, because everything below is async: two
  // clicks landing in the same window would both observe status='in_progress'
  // and both proceed. SQLite applies this atomically, so exactly one caller can
  // ever see changes === 1. The claim is on submitted_at rather than a new
  // status value so the existing status vocabulary — which several queries
  // filter on — stays untouched.
  //
  // It is a LEASE, not a permanent flag. A claim only ever released in-process
  // is lost if the process dies mid-submission — and Railway restarts the bot on
  // every deploy — which left the row 'in_progress' with submitted_at set and no
  // way back: every later click answered "already submitted" forever. Past the
  // lease the row can be claimed again, and the reuse logic below stops that
  // retry from duplicating anything the dead attempt had already created.
  const claim = db
    .prepare(
      `UPDATE applications
          SET submitted_at = datetime('now')
        WHERE id = ? AND status = 'in_progress'
          AND (submitted_at IS NULL OR submitted_at <= datetime('now', ?))`,
    )
    .run(applicationId, `-${SUBMISSION_LEASE_MINUTES} minutes`);

  if (claim.changes === 0) {
    logger.info(
      'Applications',
      `Ignored duplicate submission of application #${applicationId} by ${user.tag} (status: ${application.status})`,
    );
    return 'already_submitted';
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

  // Give the claim back if submission fails, so the applicant can retry from the
  // same summary message. Without this a transient Discord error would leave the
  // application permanently stuck reporting "already submitted".
  const releaseClaim = (): void => {
    db.prepare(
      `UPDATE applications SET submitted_at = NULL WHERE id = ? AND status = 'in_progress'`,
    ).run(applicationId);
  };

  // Step 1: Create text channel — unless a previous attempt already made one.
  // Reuse is what makes the retry above safe: without it, a submission that
  // failed after creating the channel would build a second one, which is exactly
  // the duplicate this whole guard exists to prevent.
  let channel = await findExistingChannel(guild, application.channel_id);

  if (channel) {
    logger.info(
      'Applications',
      `Reusing existing channel ${channel.id} for application #${applicationId}`,
    );
  } else {
    try {
      channel = await createApplicationChannel(guild, channelName, user, qaText);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error(
        'Applications',
        `Failed to create application channel for #${applicationId}: ${error.message}`,
        error,
      );
      releaseClaim();
      throw new Error(`Failed to create application channel: ${error.message}`, { cause: err });
    }

    // Persist immediately, not at Step 3. Everything between here and there can
    // fail, and an id recorded only at the end is an id a retry cannot reuse.
    db.prepare('UPDATE applications SET channel_id = ? WHERE id = ?').run(
      channel.id,
      applicationId,
    );
  }

  // Step 2: Create forum post
  let forumPost: { id: string } | null = null;
  let threadId: string | null = null;
  let altsMessageId: string | undefined;
  let guildsMessageId: string | undefined;
  let logsMessageId: string | undefined;
  // Parsed BEFORE the forum post, because the same list decides two things: whether
  // to reserve the three intel placeholders, and whether to queue the sweep. When
  // those were separate decisions an application with no parseable Raider.IO URL
  // got placeholders that nothing would ever edit.
  const named = collectRaiderIoCharacters(answers);
  const existingThread = await findExistingThread(guild, application.thread_id);

  if (existingThread) {
    // Same reasoning as the channel: a retry must not post the applicant a
    // second time into the forum officers are already reviewing in.
    logger.info(
      'Applications',
      `Reusing existing forum thread ${existingThread} for application #${applicationId}`,
    );
    threadId = existingThread;
    forumPost = application.forum_post_id ? { id: application.forum_post_id } : null;
  } else {
    try {
      const result = await createForumPost(
        guild,
        characterName,
        user,
        qaText,
        applicationId,
        named,
      );
      forumPost = result.forumPost;
      threadId = result.threadId;
      altsMessageId = result.altsMessageId;
      guildsMessageId = result.guildsMessageId;
      logsMessageId = result.logsMessageId;
      db.prepare('UPDATE applications SET forum_post_id = ?, thread_id = ? WHERE id = ?').run(
        forumPost?.id ?? null,
        threadId,
        applicationId,
      );
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error(
        'Applications',
        `Failed to create forum post for #${applicationId}: ${error.message}`,
        error,
      );
      // Don't throw here - the text channel was already created, so update the record with what we have
    }
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
    releaseClaim();
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

  // Step 5: kick off the applicant intel sweep. This only QUEUES the job —
  // the scheduler runs it later — so submission stays fast and a problem
  // here can never fail the application. The job row is written before any
  // API call, so a crash mid-queue loses nothing; the scheduler picks it up.
  if (threadId) {
    try {
      if (named.length > 0) {
        const jobId = startIntelJob({
          applicationId,
          targetChannelId: threadId,
          // Every character the applicant named, not just the first — all of
          // them are always swept and labelled "from the application".
          characters: named,
          // Drives the Discord confirmation pass on discovered characters.
          applicantDiscord: user.username,
          altsMessageId,
          guildsMessageId,
          logsMessageId,
        });
        logger.info('Applications', `Queued intel job #${jobId} for application #${applicationId}`);
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.warn(
        'Applications',
        `Failed to queue intel job for #${applicationId}: ${error.message}`,
      );
    }
  }

  logger.info(
    'Applications',
    `Application #${applicationId} submitted by ${user.tag} (${characterName}) - channel: ${channel.id}`,
  );

  return 'submitted';
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

/**
 * The application's text channel from a previous attempt, if it still exists.
 *
 * A recorded id whose channel has since been deleted returns null so a fresh one
 * is created — the point is never to duplicate a channel that is still there.
 */
async function findExistingChannel(
  guild: Guild,
  channelId: string | null | undefined,
): Promise<TextChannel | null> {
  if (!channelId) return null;

  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return null;

  return channel as TextChannel;
}

/** The application's forum thread from a previous attempt, if it still exists. */
async function findExistingThread(
  guild: Guild,
  threadId: string | null | undefined,
): Promise<string | null> {
  if (!threadId) return null;

  const thread = await guild.channels.fetch(threadId).catch(() => null);
  return thread ? threadId : null;
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

  // Post Q&A (split if > 2000 chars). Deliberately non-fatal: the channel now
  // exists, so throwing here would report a failed submission while leaving a
  // real channel behind, and the retry that followed would create a second one.
  // The same Q&A also goes to the forum thread, which is where officers review.
  const messages = splitMessage(qaText);
  for (const msg of messages) {
    try {
      await channel.send(msg);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.warn('Applications', `Failed to post Q&A to channel ${channel.id}: ${error.message}`);
      break;
    }
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

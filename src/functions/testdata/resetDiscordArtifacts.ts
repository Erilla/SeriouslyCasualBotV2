import {
  type Client,
  type Guild,
  type GuildBasedChannel,
  DiscordAPIError,
  RESTJSONErrorCodes,
} from 'discord.js';
import type Database from 'better-sqlite3';
import { config } from '../../config.js';
import { logger } from '../../services/logger.js';

export interface ArtifactError {
  kind: string;
  id: string;
  message: string;
}

export interface ResetArtifactsResult {
  deleted: number;
  alreadyMissing: number;
  errors: ArtifactError[];
}

// Treat 404-ish errors as "already gone" so a partial earlier run or
// manual cleanup doesn't block the reset. Everything else is a real
// failure that must stop us before we wipe the DB (per #30: consistent
// state + rollback on error).
const MISSING_CODES = new Set<number>([
  RESTJSONErrorCodes.UnknownChannel,
  RESTJSONErrorCodes.UnknownMessage,
  RESTJSONErrorCodes.UnknownGuild,
]);

function isMissing(err: unknown): boolean {
  return err instanceof DiscordAPIError && typeof err.code === 'number' && MISSING_CODES.has(err.code);
}

interface ArtifactRow {
  kind: string;
  // A channel/thread/message reference to delete. `parentId` lets us fetch
  // a message by its parent channel (messages can't be fetched by id alone).
  id: string;
  parentId?: string;
}

function collectArtifactIds(db: Database.Database): ArtifactRow[] {
  const rows: ArtifactRow[] = [];

  // Per-applicant text channels (app-{name} under Applications category).
  for (const r of db
    .prepare(`SELECT channel_id FROM applications WHERE channel_id IS NOT NULL`)
    .all() as { channel_id: string }[]) {
    rows.push({ kind: 'application:channel', id: r.channel_id });
  }

  // Forum threads (applications log).
  for (const r of db
    .prepare(`SELECT forum_post_id FROM applications WHERE forum_post_id IS NOT NULL`)
    .all() as { forum_post_id: string }[]) {
    rows.push({ kind: 'application:forum_thread', id: r.forum_post_id });
  }

  // thread_id for applications is usually the same as forum_post_id (the
  // initial forum thread is the post). Include distinct values only so we
  // don't issue a duplicate delete.
  const seenForumIds = new Set(rows.filter((x) => x.kind === 'application:forum_thread').map((x) => x.id));
  for (const r of db
    .prepare(`SELECT thread_id FROM applications WHERE thread_id IS NOT NULL`)
    .all() as { thread_id: string }[]) {
    if (!seenForumIds.has(r.thread_id)) {
      rows.push({ kind: 'application:thread', id: r.thread_id });
    }
  }

  // Trial review threads + promotion-decision threads (both live in the
  // trial_reviews_forum, so each is a deletable channel).
  for (const r of db
    .prepare(`SELECT thread_id FROM trials WHERE thread_id IS NOT NULL`)
    .all() as { thread_id: string }[]) {
    rows.push({ kind: 'trial:thread', id: r.thread_id });
  }
  for (const r of db
    .prepare(`SELECT thread_id FROM promote_alerts WHERE thread_id IS NOT NULL`)
    .all() as { thread_id: string }[]) {
    rows.push({ kind: 'promote_alert:thread', id: r.thread_id });
  }

  // Loot post messages (parent channel lookup needed to delete).
  for (const r of db
    .prepare(`SELECT channel_id, message_id FROM loot_posts WHERE message_id IS NOT NULL`)
    .all() as { channel_id: string; message_id: string }[]) {
    rows.push({ kind: 'loot:message', id: r.message_id, parentId: r.channel_id });
  }

  // Raider linking messages (parent is raider-setup channel from config).
  const raiderSetup = db
    .prepare(`SELECT value FROM config WHERE key = 'raider_setup_channel_id'`)
    .get() as { value: string } | undefined;
  if (raiderSetup) {
    for (const r of db
      .prepare(`SELECT message_id FROM raiders WHERE message_id IS NOT NULL`)
      .all() as { message_id: string }[]) {
      rows.push({ kind: 'raider:link_message', id: r.message_id, parentId: raiderSetup.value });
    }
  }

  // Guild-info messages (About Us / Schedule / Recruitment), posted to the
  // guild_info channel.
  const guildInfo = db
    .prepare(`SELECT value FROM config WHERE key = 'guild_info_channel_id'`)
    .get() as { value: string } | undefined;
  if (guildInfo) {
    for (const r of db
      .prepare(`SELECT message_id FROM guild_info_messages`)
      .all() as { message_id: string }[]) {
      rows.push({ kind: 'guild_info:message', id: r.message_id, parentId: guildInfo.value });
    }
  }

  return rows;
}

async function deleteChannelOrThread(
  guild: Guild,
  id: string,
): Promise<'deleted' | 'missing'> {
  let channel: GuildBasedChannel | null;
  try {
    channel = await guild.channels.fetch(id);
  } catch (err) {
    if (isMissing(err)) return 'missing';
    throw err;
  }
  if (!channel) return 'missing';
  try {
    await channel.delete();
    return 'deleted';
  } catch (err) {
    if (isMissing(err)) return 'missing';
    throw err;
  }
}

async function deleteMessage(
  guild: Guild,
  messageId: string,
  parentChannelId: string,
): Promise<'deleted' | 'missing'> {
  let parent: GuildBasedChannel | null;
  try {
    parent = await guild.channels.fetch(parentChannelId);
  } catch (err) {
    if (isMissing(err)) return 'missing';
    throw err;
  }
  if (!parent || !('messages' in parent)) return 'missing';
  try {
    const msg = await parent.messages.fetch(messageId);
    await msg.delete();
    return 'deleted';
  } catch (err) {
    if (isMissing(err)) return 'missing';
    throw err;
  }
}

/**
 * Tears down Discord artifacts that correspond to rows in the DB, so that a
 * subsequent DB wipe + re-seed leaves Discord in sync with the database.
 *
 * Strategy (#30):
 *   1. Snapshot all artifact IDs from the DB before deleting anything.
 *   2. Delete each artifact, swallowing 404-ish errors (Unknown Channel,
 *      Unknown Message) — those mean the item is already gone, which is
 *      the desired end state anyway.
 *   3. Accumulate real errors (permissions, rate limits, transport) and
 *      return them. Caller is expected to abort the DB wipe when
 *      `errors.length > 0`, so we don't end up with DB rows gone but
 *      Discord artifacts still dangling.
 *
 * Artifacts NOT touched:
 *   - Auto-created infrastructure channels (bot-logs, raider-setup, the
 *     applications category itself). Those are ops-level, not seed-level.
 *   - Anything the bot didn't record an ID for.
 */
export async function resetDiscordArtifacts(
  client: Client,
  db: Database.Database,
): Promise<ResetArtifactsResult> {
  const result: ResetArtifactsResult = { deleted: 0, alreadyMissing: 0, errors: [] };

  const guild = await client.guilds.fetch(config.guildId).catch(() => null);
  if (!guild) {
    result.errors.push({
      kind: 'guild',
      id: config.guildId,
      message: `Could not fetch guild ${config.guildId}`,
    });
    return result;
  }

  const artifacts = collectArtifactIds(db);
  logger.info('TestData', `Cleaning up ${artifacts.length} Discord artifacts before DB wipe`);

  for (const art of artifacts) {
    try {
      const outcome = art.parentId
        ? await deleteMessage(guild, art.id, art.parentId)
        : await deleteChannelOrThread(guild, art.id);
      if (outcome === 'deleted') result.deleted++;
      else result.alreadyMissing++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push({ kind: art.kind, id: art.id, message });
      // Keep going so a single bad artifact doesn't hide systemic issues
      // from the summary. The caller still aborts the DB wipe if errors > 0.
    }
  }

  return result;
}

import {
  ChannelType,
  type Guild,
  type CategoryChannel,
  type ForumChannel,
  type GuildBasedChannel,
  type GuildChannelCreateOptions,
  type TextChannel,
} from 'discord.js';
import { getDatabase } from '../database/db.js';
import { logger } from '../services/logger.js';

export function getCategoryByName(guild: Guild, name: string): CategoryChannel | null {
  const target = name.toLowerCase();
  const match = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === target,
  );
  return (match as CategoryChannel | undefined) ?? null;
}

export interface GetOrCreateChannelOptions {
  name: string;
  type: ChannelType.GuildText | ChannelType.GuildForum | ChannelType.GuildCategory;
  categoryName: string | null;
  configKey: string;
  aliasNames?: string[];
  createOptions?: Partial<GuildChannelCreateOptions>;
}

const warnedMissingCategoriesPerGuild = new WeakMap<Guild, Set<string>>();

// Gate the REST channel-list refresh to at most one call per guild per process.
// After the first refresh the cache is kept live by gateway events, so further
// full-fetch calls are redundant and hammer the API unnecessarily.
const refreshedGuilds = new WeakSet<Guild>();

/** In-flight refresh promises keyed by guild reference; concurrent callers share one fetch. */
const refreshingGuilds = new WeakMap<Guild, Promise<unknown>>();

async function refreshGuildChannelsOnce(guild: Guild): Promise<void> {
  if (refreshedGuilds.has(guild)) return;

  let inflight = refreshingGuilds.get(guild);
  if (!inflight) {
    inflight = guild.channels
      .fetch()
      .then(() => {
        refreshedGuilds.add(guild);
      })
      .finally(() => {
        refreshingGuilds.delete(guild);
      });
    refreshingGuilds.set(guild, inflight);
  }
  await inflight;
}

function shouldWarnAboutMissingCategory(guild: Guild, categoryName: string): boolean {
  let set = warnedMissingCategoriesPerGuild.get(guild);
  if (!set) {
    set = new Set();
    warnedMissingCategoriesPerGuild.set(guild, set);
  }
  if (set.has(categoryName)) return false;
  set.add(categoryName);
  return true;
}

function readConfig(key: string): string | undefined {
  const row = getDatabase().prepare('SELECT value FROM config WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

function writeConfig(key: string, value: string): void {
  getDatabase()
    .prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)')
    .run(key, value);
}

function deleteConfig(key: string): void {
  getDatabase().prepare('DELETE FROM config WHERE key = ?').run(key);
}

// In-flight dedup: prevents concurrent calls for the same configKey from each
// triggering their own guild.channels.create when all of them miss the cache.
// Outer WeakMap is keyed by guild reference (GC-friendly across tests); inner
// Map is keyed by configKey so dedup is scoped per-guild.
const inflightResolves = new WeakMap<Guild, Map<string, Promise<GuildBasedChannel>>>();

function getInflightForGuild(guild: Guild): Map<string, Promise<GuildBasedChannel>> {
  let m = inflightResolves.get(guild);
  if (!m) {
    m = new Map();
    inflightResolves.set(guild, m);
  }
  return m;
}

export function getOrCreateChannel(
  guild: Guild,
  opts: GetOrCreateChannelOptions & { type: ChannelType.GuildText },
): Promise<TextChannel>;
export function getOrCreateChannel(
  guild: Guild,
  opts: GetOrCreateChannelOptions & { type: ChannelType.GuildForum },
): Promise<ForumChannel>;
export function getOrCreateChannel(
  guild: Guild,
  opts: GetOrCreateChannelOptions & { type: ChannelType.GuildCategory },
): Promise<CategoryChannel>;
export function getOrCreateChannel(
  guild: Guild,
  opts: GetOrCreateChannelOptions,
): Promise<GuildBasedChannel> {
  const perGuild = getInflightForGuild(guild);
  const existing = perGuild.get(opts.configKey);
  if (existing) return existing;

  const promise = resolveChannelImpl(guild, opts);
  perGuild.set(opts.configKey, promise);
  promise.finally(() => {
    perGuild.delete(opts.configKey);
  });
  return promise;
}

interface NamedMatch {
  channel: GuildBasedChannel;
  targetIndex: number;
}

function scanChannelsByTargets(
  channels: Iterable<GuildBasedChannel>,
  targets: string[],
  expectedType: ChannelType,
): { correctMatches: NamedMatch[]; wrongMatches: NamedMatch[] } {
  const correctMatches: NamedMatch[] = [];
  const wrongMatches: NamedMatch[] = [];
  for (const c of channels) {
    const idx = targets.indexOf(c.name.toLowerCase());
    if (idx < 0) continue;
    const match: NamedMatch = { channel: c, targetIndex: idx };
    if (c.type === expectedType) correctMatches.push(match);
    else wrongMatches.push(match);
  }
  return { correctMatches, wrongMatches };
}

async function resolveChannelImpl(
  guild: Guild,
  opts: GetOrCreateChannelOptions,
): Promise<GuildBasedChannel> {
  // 1. Stored config ID
  const storedId = readConfig(opts.configKey);
  if (storedId) {
    const cached =
      guild.channels.cache.get(storedId) ??
      (await guild.channels.fetch(storedId).catch(() => null));
    if (cached) {
      if (cached.type === opts.type) {
        return cached as GuildBasedChannel;
      }
      logger.warn(
        'channels',
        `Config key "${opts.configKey}" points to channel ${storedId} but its type is ${ChannelType[cached.type]} (expected ${ChannelType[opts.type]}); clearing stale config and falling through.`,
      );
    } else {
      logger.warn(
        'channels',
        `Config key "${opts.configKey}" points to deleted/inaccessible channel ${storedId}; clearing.`,
      );
    }
    deleteConfig(opts.configKey);
  }

  // 2. Name lookup (case-insensitive; checks opts.name first, then each aliasName
  // in order). Single pass over the cache; we always warn about wrong-type
  // matches even when a correct match resolves under a different target, so
  // operators can clean up stray channels.
  // Dedup via Set to avoid redundant cache iterations when name === aliasName[i].
  // new Set preserves insertion order per spec, so primary name still beats aliases.
  const targets = [...new Set(
    [opts.name, ...(opts.aliasNames ?? [])].map((n) => n.toLowerCase()),
  )];

  const { correctMatches, wrongMatches } = scanChannelsByTargets(
    guild.channels.cache.values() as Iterable<GuildBasedChannel>,
    targets,
    opts.type,
  );

  if (wrongMatches.length > 0) {
    const details = wrongMatches
      .map((m) => `"${m.channel.name}" (${m.channel.id}, type ${ChannelType[m.channel.type]})`)
      .join(', ');
    logger.warn(
      'channels',
      `Found channel(s) with name matching "${opts.name}"` +
        (opts.aliasNames?.length ? ' or one of its aliases' : '') +
        ` but wrong type (expected ${ChannelType[opts.type]}): ${details}.`,
    );
  }

  if (correctMatches.length > 0) {
    // Sort by target priority (primary name beats aliases, in order).
    correctMatches.sort((a, b) => a.targetIndex - b.targetIndex);
    const resolved = correctMatches[0].channel;

    // If multiple correctly-typed channels exist under the *same* target
    // (true duplicate), warn.
    const sameTargetDuplicates = correctMatches.filter(
      (m) => m.targetIndex === correctMatches[0].targetIndex,
    );
    if (sameTargetDuplicates.length > 1) {
      const ids = sameTargetDuplicates.map((m) => m.channel.id).join(', ');
      logger.warn(
        'channels',
        `Multiple channels named "${resolved.name}" found: ${ids}. Using the first.`,
      );
    }

    writeConfig(opts.configKey, resolved.id);
    logger.info(
      'channels',
      `Reusing existing channel "${resolved.name}" (${resolved.id}) for ${opts.configKey}`,
    );
    return resolved;
  }

  // The discord.js cache can be stale or incomplete at startup (guild not
  // fully populated before ready fires). Do one REST refresh per guild per
  // process and retry the scan — after that, the cache is maintained live
  // by gateway events, so further refreshes are redundant.
  // Concurrent callers for different configKeys (bypassing the inflight-dedup
  // map) share a single in-flight fetch promise via refreshGuildChannelsOnce.
  // On failure, the guild is not marked as refreshed, so subsequent callers
  // can retry.
  if (!refreshedGuilds.has(guild) || refreshingGuilds.has(guild)) {
    try {
      await refreshGuildChannelsOnce(guild);
    } catch (err) {
      logger.warn(
        'channels',
        `Channel cache refresh failed for guild ${guild.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const {
      correctMatches: refreshedCorrectMatches,
      wrongMatches: refreshedWrongMatches,
    } = scanChannelsByTargets(
      guild.channels.cache.values() as Iterable<GuildBasedChannel>,
      targets,
      opts.type,
    );

    const existingWrongIds = new Set(wrongMatches.map((m) => m.channel.id));
    const freshWrongMatches = refreshedWrongMatches.filter((m) => !existingWrongIds.has(m.channel.id));
    if (freshWrongMatches.length > 0) {
      const details = freshWrongMatches
        .map((m) => `"${m.channel.name}" (${m.channel.id}, type ${ChannelType[m.channel.type]})`)
        .join(', ');
      logger.warn(
        'channels',
        `Found additional wrong-typed channel(s) after cache refresh: ${details}.`,
      );
    }

    if (refreshedCorrectMatches.length > 0) {
      refreshedCorrectMatches.sort((a, b) => a.targetIndex - b.targetIndex);
      const resolved = refreshedCorrectMatches[0].channel;
      writeConfig(opts.configKey, resolved.id);
      logger.info(
        'channels',
        `Reusing existing channel "${resolved.name}" (${resolved.id}) for ${opts.configKey} (found after cache refresh)`,
      );
      return resolved;
    }
  }

  // 3. Parent category — skip entirely for GuildCategory (categories can't be
  // nested under another category; step 4 guards this too as defense in depth).
  let parentId: string | undefined;
  if (opts.categoryName && opts.type !== ChannelType.GuildCategory) {
    const cat = getCategoryByName(guild, opts.categoryName);
    if (cat) {
      parentId = cat.id;
    } else if (
      !opts.createOptions?.parent &&
      shouldWarnAboutMissingCategory(guild, opts.categoryName)
    ) {
      logger.warn(
        'channels',
        `Category "${opts.categoryName}" not found; "${opts.name}" will be created without a parent.`,
      );
    }
  }

  // 4. Create — categories cannot have a parent, so guard against passing one.
  // createOptions is spread first so our explicit name/type/parent always win.
  const created = (await guild.channels.create({
    ...opts.createOptions,
    name: opts.name,
    type: opts.type,
    parent: opts.type === ChannelType.GuildCategory ? undefined : (parentId ?? opts.createOptions?.parent),
  })) as GuildBasedChannel;

  writeConfig(opts.configKey, created.id);
  logger.info('channels', `Created channel "${opts.name}" (${created.id}) for ${opts.configKey}`);
  return created;
}

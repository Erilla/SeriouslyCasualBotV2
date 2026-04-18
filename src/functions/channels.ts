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
const inflightResolves = new Map<string, Promise<GuildBasedChannel>>();

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
  const existing = inflightResolves.get(opts.configKey);
  if (existing) return existing;

  const promise = resolveChannelImpl(guild, opts);
  inflightResolves.set(opts.configKey, promise);
  promise.finally(() => {
    inflightResolves.delete(opts.configKey);
  });
  return promise;
}

interface NamedMatch {
  channel: GuildBasedChannel;
  targetIndex: number;
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

  const correctMatches: NamedMatch[] = [];
  const wrongMatches: NamedMatch[] = [];

  for (const c of guild.channels.cache.values()) {
    const idx = targets.indexOf(c.name.toLowerCase());
    if (idx < 0) continue;
    const match: NamedMatch = { channel: c as GuildBasedChannel, targetIndex: idx };
    if (c.type === opts.type) {
      correctMatches.push(match);
    } else {
      wrongMatches.push(match);
    }
  }

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

  // 3. Parent category
  let parentId: string | undefined;
  if (opts.categoryName) {
    const cat = getCategoryByName(guild, opts.categoryName);
    if (cat) {
      parentId = cat.id;
    } else if (shouldWarnAboutMissingCategory(guild, opts.categoryName)) {
      logger.warn(
        'channels',
        `Category "${opts.categoryName}" not found; "${opts.name}" will be created without a parent.`,
      );
    }
  }

  // 4. Create — categories cannot have a parent, so guard against passing one.
  const created = (await guild.channels.create({
    name: opts.name,
    type: opts.type,
    parent: opts.type === ChannelType.GuildCategory ? undefined : parentId,
    ...opts.createOptions,
  })) as GuildBasedChannel;

  writeConfig(opts.configKey, created.id);
  logger.info('channels', `Created channel "${opts.name}" (${created.id}) for ${opts.configKey}`);
  return created;
}

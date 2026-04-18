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

const warnedMissingCategories = new Set<string>();

/** Test-only: resets per-process warn state. Do not call from production code. */
export function _resetWarnedCategoriesForTesting(): void {
  warnedMissingCategories.clear();
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
export async function getOrCreateChannel(
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
        `Config key "${opts.configKey}" points to channel ${storedId} but its type is ${cached.type} (expected ${opts.type}); clearing stale config and falling through.`,
      );
    } else {
      logger.warn(
        'channels',
        `Config key "${opts.configKey}" points to deleted/inaccessible channel ${storedId}; clearing.`,
      );
    }
    deleteConfig(opts.configKey);
  }

  // 2. Name lookup — iterate targets in preference order (primary name first, then
  // aliases) so the primary name always wins over an alias when both are present.
  // This avoids the non-determinism of scanning the cache and asking "is this name
  // in targets?" (which lets whichever entry the Map happens to yield first win).
  // We also drop the `as unknown as GuildBasedChannel[]` double-cast by iterating
  // the cache values() iterator directly; each value is already a GuildBasedChannel.
  const targets = [opts.name, ...(opts.aliasNames ?? [])];
  let correctlyTyped: GuildBasedChannel | undefined;
  const correctlyTypedAll: GuildBasedChannel[] = []; // collect for duplicate-warn
  const wrongTyped: GuildBasedChannel[] = [];

  outer: for (const target of targets) {
    const lc = target.toLowerCase();
    const matchesForTarget: GuildBasedChannel[] = [];
    for (const c of guild.channels.cache.values() as IterableIterator<GuildBasedChannel>) {
      if (c.name.toLowerCase() !== lc) continue;
      if (c.type === opts.type) {
        matchesForTarget.push(c);
      } else {
        wrongTyped.push(c);
      }
    }
    if (matchesForTarget.length > 0) {
      correctlyTypedAll.push(...matchesForTarget);
      correctlyTyped = matchesForTarget[0];
      break outer; // stop at first preference-order target that has a correctly-typed match
    }
  }

  if (wrongTyped.length > 0 && !correctlyTyped) {
    // Only warn about wrong-typed channels when there is no correctly-typed match
    const ids = wrongTyped.map((c) => c.id).join(', ');
    logger.warn(
      'channels',
      `Found "${opts.name}" with wrong channel type (expected ${opts.type}); existing channel(s): ${ids}. Will create a correctly-typed channel.`,
    );
  }

  if (correctlyTyped) {
    if (correctlyTypedAll.length > 1) {
      const ids = correctlyTypedAll.map((c) => c.id).join(', ');
      logger.warn(
        'channels',
        `Multiple channels named "${opts.name}" found: ${ids}. Using the first.`,
      );
    }
    writeConfig(opts.configKey, correctlyTyped.id);
    logger.info(
      'channels',
      `Reusing existing channel "${opts.name}" (${correctlyTyped.id}) for ${opts.configKey}`,
    );
    return correctlyTyped;
  }

  // 3. Parent category
  let parentId: string | undefined;
  if (opts.categoryName) {
    const cat = getCategoryByName(guild, opts.categoryName);
    if (cat) {
      parentId = cat.id;
    } else if (!warnedMissingCategories.has(opts.categoryName)) {
      warnedMissingCategories.add(opts.categoryName);
      logger.warn(
        'channels',
        `Category "${opts.categoryName}" not found; "${opts.name}" will be created without a parent.`,
      );
    }
  }

  // 4. Create
  const created = (await guild.channels.create({
    name: opts.name,
    type: opts.type,
    parent: parentId,
    ...opts.createOptions,
  })) as GuildBasedChannel;

  writeConfig(opts.configKey, created.id);
  logger.info('channels', `Created channel "${opts.name}" (${created.id}) for ${opts.configKey}`);
  return created;
}

import {
  ChannelType,
  type Guild,
  type CategoryChannel,
  type GuildBasedChannel,
  type GuildChannelCreateOptions,
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

  // 2. Name lookup (case-insensitive; checks opts.name and any aliasNames).
  // Materialize the cache as an array so subsequent filter/.length/[0] are
  // plain array ops (Collection.filter returns a Collection, not an array).
  const targets = [opts.name, ...(opts.aliasNames ?? [])].map((n) => n.toLowerCase());
  const allChannels = [...guild.channels.cache.values()] as unknown as GuildBasedChannel[];
  const nameMatches = allChannels.filter((c) => targets.includes(c.name.toLowerCase()));
  const correctlyTypedMatches = nameMatches.filter((c) => c.type === opts.type);
  const wrongTypedMatches = nameMatches.filter((c) => c.type !== opts.type);

  if (wrongTypedMatches.length > 0) {
    const ids = wrongTypedMatches.map((c) => c.id).join(', ');
    logger.warn(
      'channels',
      `Found "${opts.name}" with wrong channel type (expected ${opts.type}); existing channel(s): ${ids}. Will create a correctly-typed channel.`,
    );
  }

  if (correctlyTypedMatches.length > 0) {
    if (correctlyTypedMatches.length > 1) {
      const ids = correctlyTypedMatches.map((c) => c.id).join(', ');
      logger.warn(
        'channels',
        `Multiple channels named "${opts.name}" found: ${ids}. Using the first.`,
      );
    }
    const resolved = correctlyTypedMatches[0];
    writeConfig(opts.configKey, resolved.id);
    logger.info(
      'channels',
      `Reusing existing channel "${opts.name}" (${resolved.id}) for ${opts.configKey}`,
    );
    return resolved;
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

import { ChannelType, type CategoryChannel, type Guild, type GuildBasedChannel } from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';

export const APPLICATION_LOG_CATEGORY_CONFIG_KEY = 'application_log_category_id';

const LEGACY_CATEGORY_NAME = 'Application-logs';
const CURRENT_CATEGORY_NAME = /^(?:🟥 )?APPLICATION LOGS · \d+ PENDING$/;

export function buildPendingApplicationCategoryName(count: number): string {
  const prefix = count > 0 ? '🟥 ' : '';
  return `${prefix}APPLICATION LOGS · ${count} PENDING`;
}

function readCategoryId(): string | undefined {
  const row = getDatabase()
    .prepare('SELECT value FROM config WHERE key = ?')
    .get(APPLICATION_LOG_CATEGORY_CONFIG_KEY) as { value: string } | undefined;
  return row?.value;
}

function saveCategoryId(categoryId: string): void {
  getDatabase()
    .prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)')
    .run(APPLICATION_LOG_CATEGORY_CONFIG_KEY, categoryId);
}

function clearCategoryId(): void {
  getDatabase()
    .prepare('DELETE FROM config WHERE key = ?')
    .run(APPLICATION_LOG_CATEGORY_CONFIG_KEY);
}

function isCategory(channel: GuildBasedChannel | null | undefined): channel is CategoryChannel {
  return channel?.type === ChannelType.GuildCategory;
}

function isApplicationLogCategory(channel: GuildBasedChannel): channel is CategoryChannel {
  return (
    channel.type === ChannelType.GuildCategory &&
    (channel.name === LEGACY_CATEGORY_NAME || CURRENT_CATEGORY_NAME.test(channel.name))
  );
}

export async function resolveApplicationLogCategory(guild: Guild): Promise<CategoryChannel | null> {
  try {
    const storedId = readCategoryId();
    if (storedId) {
      const channel =
        guild.channels.cache.get(storedId) ??
        (await guild.channels.fetch(storedId).catch(() => null));
      if (isCategory(channel)) return channel;

      logger.warn(
        'Applications',
        `Application-log category config points to a missing or non-category channel (${storedId}); clearing it.`,
      );
      clearCategoryId();
    }

    const category = [...guild.channels.cache.values()].find(isApplicationLogCategory);
    if (category) {
      saveCategoryId(category.id);
      return category;
    }

    logger.warn('Applications', 'Application-log category could not be found.');
    return null;
  } catch (error) {
    logger.warn('Applications', `Failed to resolve application-log category: ${String(error)}`);
    return null;
  }
}

export async function refreshPendingApplicationCategory(guild: Guild): Promise<void> {
  try {
    const category = await resolveApplicationLogCategory(guild);
    if (!category) return;
    const row = getDatabase()
      .prepare("SELECT COUNT(*) AS count FROM applications WHERE status = 'active'")
      .get() as { count: number };
    const name = buildPendingApplicationCategoryName(row.count);
    if (category.name !== name) await category.setName(name);
  } catch (error) {
    logger.warn('Applications', `Failed to refresh pending application category: ${String(error)}`);
  }
}

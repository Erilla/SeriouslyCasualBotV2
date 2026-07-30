import { type Client, ChannelType, type TextChannel } from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';
import { config } from '../../config.js';
import { getOrCreateChannel } from '../channels.js';
import { isUnknownGuildInfoMessage, MANAGED_GUILD_INFO_KEYS } from './managedGuildInfoMessage.js';

/**
 * Delete tracked guild-info messages and clear their message IDs for a forced rebuild.
 */
export async function clearGuildInfo(client: Client): Promise<void> {
  const channel = await getOrCreateGuildInfoChannel(client);
  if (!channel) {
    logger.warn('guild-info', 'Could not resolve guild info channel');
    return;
  }

  const db = getDatabase();
  const placeholders = MANAGED_GUILD_INFO_KEYS.map(() => '?').join(', ');
  const rows = db
    .prepare(`SELECT key, message_id FROM guild_info_messages WHERE key IN (${placeholders})`)
    .all(...MANAGED_GUILD_INFO_KEYS) as { key: string; message_id: string }[];
  const messageIds = new Map(rows.map((row) => [row.key, row.message_id]));

  for (const key of MANAGED_GUILD_INFO_KEYS) {
    const messageId = messageIds.get(key);
    if (!messageId) continue;

    try {
      await channel.messages.delete(messageId);
    } catch (error) {
      if (!isUnknownGuildInfoMessage(error)) {
        throw error;
      }
    }
  }

  db.prepare(`DELETE FROM guild_info_messages WHERE key IN (${placeholders})`).run(
    ...MANAGED_GUILD_INFO_KEYS,
  );
}

/**
 * Get the guild info channel from config, or find an existing one by name.
 * Only creates a new channel as a last resort.
 */
export async function getOrCreateGuildInfoChannel(client: Client): Promise<TextChannel | null> {
  try {
    const guild = await client.guilds.fetch(config.guildId);
    const channel = await getOrCreateChannel(guild, {
      name: 'guild-info',
      type: ChannelType.GuildText,
      categoryName: null,
      configKey: 'guild_info_channel_id',
      aliasNames: ['welcome'],
    });
    return channel;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('guild-info', `Failed to resolve guild info channel: ${err.message}`, err);
    return null;
  }
}

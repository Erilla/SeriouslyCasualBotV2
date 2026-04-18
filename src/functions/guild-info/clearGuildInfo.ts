import { type Client, type Message, ChannelType, type TextChannel } from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';
import { config } from '../../config.js';
import { getOrCreateChannel } from '../channels.js';

/**
 * Delete all messages in the guild info channel and clear the guild_info_messages table.
 */
export async function clearGuildInfo(client: Client): Promise<void> {
  const channel = await getOrCreateGuildInfoChannel(client);
  if (!channel) {
    logger.warn('guild-info', 'Could not resolve guild info channel');
    return;
  }

  // Fetch all messages (up to 100 at a time)
  let fetched;
  const allMessages: Message[] = [];

  do {
    fetched = await channel.messages.fetch({
      limit: 100,
      ...(allMessages.length > 0 ? { before: allMessages[allMessages.length - 1].id } : {}),
    });
    allMessages.push(...fetched.values());
  } while (fetched.size === 100);

  if (allMessages.length === 0) {
    logger.debug('guild-info', 'No messages to clear in guild info channel');
  } else {
    // Split into messages < 14 days old (bulk deletable) and older ones
    const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const recent = allMessages.filter((m) => m.createdTimestamp > twoWeeksAgo);
    const old = allMessages.filter((m) => m.createdTimestamp <= twoWeeksAgo);

    // Bulk delete recent messages (in chunks of 100)
    for (let i = 0; i < recent.length; i += 100) {
      const chunk = recent.slice(i, i + 100);
      if (chunk.length === 1) {
        await chunk[0].delete();
      } else if (chunk.length > 1) {
        await channel.bulkDelete(chunk);
      }
    }

    // Delete old messages individually
    for (const message of old) {
      try {
        await message.delete();
      } catch (error) {
        logger.warn('guild-info', `Failed to delete old message ${message.id}`);
      }
    }

    logger.info('guild-info', `Cleared ${allMessages.length} messages from guild info channel`);
  }

  // Clear guild_info_messages table
  const db = getDatabase();
  db.prepare('DELETE FROM guild_info_messages').run();
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

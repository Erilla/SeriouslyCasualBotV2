import { type Client, type TextChannel, ChannelType } from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';
import type { RaiderRow, ConfigRow } from '../../types/index.js';

export async function updateRaiderDiscordUser(
  client: Client,
  characterName: string,
  userId: string,
): Promise<boolean> {
  const db = getDatabase();

  try {
    const raider = db
      .prepare('SELECT * FROM raiders WHERE character_name = ?')
      .get(characterName) as RaiderRow | undefined;

    if (!raider) {
      logger.warn('UpdateRaider', `Raider "${characterName}" not found in database`);
      return false;
    }

    db.transaction(() => {
      // Update the raider's discord_user_id
      db.prepare('UPDATE raiders SET discord_user_id = ?, message_id = NULL WHERE character_name = ?').run(
        userId,
        characterName,
      );

      // Upsert into raider_identity_map
      db.prepare(
        'INSERT OR REPLACE INTO raider_identity_map (character_name, discord_user_id) VALUES (?, ?)',
      ).run(characterName, userId);
    })();

    // Delete the linking message if it existed
    if (raider.message_id) {
      try {
        const configRow = db
          .prepare('SELECT value FROM config WHERE key = ?')
          .get('raider_setup_channel_id') as ConfigRow | undefined;

        if (configRow) {
          const channel = await client.channels.fetch(configRow.value);
          if (channel && channel.type === ChannelType.GuildText) {
            const textChannel = channel as TextChannel;
            const message = await textChannel.messages.fetch(raider.message_id);
            await message.delete();
          }
        }
      } catch {
        // Message may already be deleted, that's fine
        logger.debug('UpdateRaider', `Could not delete linking message for "${characterName}"`);
      }
    }

    logger.info('UpdateRaider', `Linked "${characterName}" to user ${userId}`);
    return true;
  } catch (error) {
    logger.error('UpdateRaider', `Failed to update raider "${characterName}"`, error as Error);
    return false;
  }
}

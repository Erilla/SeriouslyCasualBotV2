import {
  type Client,
  type TextChannel,
  type Message,
  ChannelType,
  ActionRowBuilder,
  UserSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';
import type { RaiderRow, ConfigRow } from '../../types/index.js';

export async function refreshLinkingMessages(client: Client): Promise<void> {
  const db = getDatabase();

  const configRow = db
    .prepare('SELECT value FROM config WHERE key = ?')
    .get('raider_setup_channel_id') as ConfigRow | undefined;

  if (!configRow) {
    logger.debug('RefreshLinks', 'No raider-setup channel configured, skipping refresh');
    return;
  }

  let channel: TextChannel;
  try {
    const fetched = await client.channels.fetch(configRow.value);
    if (!fetched || fetched.type !== ChannelType.GuildText) {
      logger.warn('RefreshLinks', 'Raider-setup channel is not a text channel');
      return;
    }
    channel = fetched as TextChannel;
  } catch {
    logger.warn('RefreshLinks', 'Could not fetch raider-setup channel');
    return;
  }

  // Get all raiders that still have linking messages (not yet linked)
  const raidersWithMessages = db
    .prepare('SELECT * FROM raiders WHERE message_id IS NOT NULL AND discord_user_id IS NULL')
    .all() as RaiderRow[];

  if (raidersWithMessages.length === 0) {
    logger.debug('RefreshLinks', 'No linking messages to refresh');
    return;
  }

  // Fetch the last 20 messages from the channel
  let recentMessages: Map<string, Message>;
  try {
    const fetched = await channel.messages.fetch({ limit: 20 });
    recentMessages = new Map(fetched.map((m) => [m.id, m]));
  } catch (error) {
    logger.error('RefreshLinks', 'Failed to fetch recent messages', error as Error);
    return;
  }

  let refreshed = 0;

  for (const raider of raidersWithMessages) {
    if (!raider.message_id) continue;

    // Skip if the message is already among the last 20
    if (recentMessages.has(raider.message_id)) continue;

    try {
      // Try to delete the old message
      try {
        const oldMessage = await channel.messages.fetch(raider.message_id);
        await oldMessage.delete();
      } catch {
        // Message may already be deleted, that's fine
      }

      // Repost with standard linking components (user select + ignore button)
      const userSelect = new UserSelectMenuBuilder()
        .setCustomId(`raider:select_user:${raider.character_name}`)
        .setPlaceholder('Select a user...');

      const selectRow = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(userSelect);

      const ignoreButton = new ButtonBuilder()
        .setCustomId(`raider:ignore:${raider.character_name}`)
        .setLabel('Ignore')
        .setStyle(ButtonStyle.Danger);

      const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(ignoreButton);

      const newMessage = await channel.send({
        content: `**${raider.character_name}**`,
        components: [selectRow, buttonRow],
      });

      db.prepare('UPDATE raiders SET message_id = ? WHERE character_name = ?').run(
        newMessage.id,
        raider.character_name,
      );

      refreshed++;
    } catch (error) {
      logger.error(
        'RefreshLinks',
        `Failed to refresh message for "${raider.character_name}"`,
        error as Error,
      );
    }
  }

  if (refreshed > 0) {
    logger.info('RefreshLinks', `Refreshed ${refreshed} linking messages`);
  }
}

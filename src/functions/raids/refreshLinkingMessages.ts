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
import { config } from '../../config.js';
import { getOrCreateChannel } from '../channels.js';
import type { RaiderRow, ConfigRow } from '../../types/index.js';

export async function refreshLinkingMessages(client: Client): Promise<void> {
  const db = getDatabase();

  // Short-circuit when admin has never configured this. getOrCreateChannel
  // would auto-create otherwise, and we don't want a 10-minute job silently
  // spinning up #raider-setup on guilds that opted out of the feature.
  const configRow = db
    .prepare('SELECT value FROM config WHERE key = ?')
    .get('raider_setup_channel_id') as ConfigRow | undefined;

  if (!configRow) {
    logger.debug('RefreshLinks', 'No raider-setup channel configured, skipping refresh');
    return;
  }

  // getOrCreateChannel self-heals a stale ID: fetch-by-ID fails → clear
  // config → name lookup → writeConfig with the current channel's ID.
  // Without this, a once-valid ID that points at a deleted channel would
  // warn every 10 minutes until an admin re-ran /setup set_channel (#36).
  let channel: TextChannel;
  try {
    const guild = await client.guilds.fetch(config.guildId);
    channel = await getOrCreateChannel(guild, {
      name: 'raider-setup',
      type: ChannelType.GuildText,
      categoryName: 'SeriouslyCasual Bot',
      configKey: 'raider_setup_channel_id',
    });
  } catch (error) {
    logger.error('RefreshLinks', 'Failed to resolve raider-setup channel', error as Error);
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

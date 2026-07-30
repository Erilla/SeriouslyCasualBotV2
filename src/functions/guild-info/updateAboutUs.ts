import {
  type Client,
  EmbedBuilder,
  Colors,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';
import { getOrCreateGuildInfoChannel } from './clearGuildInfo.js';
import { upsertGuildInfoMessage } from './managedGuildInfoMessage.js';
import type { GuildInfoContentRow, GuildInfoLinkRow } from '../../types/index.js';

/**
 * Post the About Us embed with link buttons to the guild info channel.
 */
export async function updateAboutUs(client: Client): Promise<void> {
  const channel = await getOrCreateGuildInfoChannel(client);
  if (!channel) {
    logger.warn('guild-info', 'Could not resolve guild info channel for About Us');
    return;
  }

  const db = getDatabase();

  // Get about us content
  const aboutUs = db.prepare('SELECT * FROM guild_info_content WHERE key = ?').get('aboutus') as
    | GuildInfoContentRow
    | undefined;
  if (!aboutUs) {
    logger.warn('guild-info', 'No aboutus content found in guild_info_content');
    return;
  }

  // Get link buttons
  const links = db
    .prepare('SELECT * FROM guild_info_links ORDER BY id')
    .all() as GuildInfoLinkRow[];

  // Build embed
  const embed = new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle(aboutUs.title ?? 'About Us')
    .setDescription(aboutUs.content);

  // Build action row with link buttons
  const messagePayload: { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } = {
    embeds: [embed],
    components: [],
  };

  if (links.length > 0) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    for (const link of links) {
      const button = new ButtonBuilder()
        .setLabel(link.label)
        .setStyle(ButtonStyle.Link)
        .setURL(link.url);

      if (link.emoji_id) {
        button.setEmoji(link.emoji_id);
      }

      row.addComponents(button);
    }
    messagePayload.components = [row];
  }

  await upsertGuildInfoMessage(channel, 'aboutus', messagePayload);

  logger.info('guild-info', 'Posted About Us embed');
}

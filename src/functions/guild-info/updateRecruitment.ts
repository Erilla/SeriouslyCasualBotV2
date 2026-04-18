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
import type { GuildInfoContentRow, OverlordRow, ConfigRow } from '../../types/index.js';

/**
 * Post the Recruitment embed with overlord mentions and an Apply Here button.
 */
export async function updateRecruitment(client: Client): Promise<void> {
  const channel = await getOrCreateGuildInfoChannel(client);
  if (!channel) {
    logger.warn('guild-info', 'Could not resolve guild info channel for Recruitment');
    return;
  }

  const db = getDatabase();

  // Get all recruitment sections in logical reading order
  const sections = db
    .prepare(
      `SELECT * FROM guild_info_content WHERE key LIKE 'recruitment_%'
       ORDER BY CASE key
         WHEN 'recruitment_who' THEN 1
         WHEN 'recruitment_want' THEN 2
         WHEN 'recruitment_give' THEN 3
         WHEN 'recruitment_contact' THEN 4
         ELSE 99
       END`,
    )
    .all() as GuildInfoContentRow[];

  if (sections.length === 0) {
    logger.warn('guild-info', 'No recruitment sections found in guild_info_content');
    return;
  }

  // Get overlords for mention string
  const overlords = db.prepare('SELECT * FROM overlords').all() as OverlordRow[];
  const overlordMentions = overlords.map((o) => `<@${o.user_id}>`).join(' / ');

  // Build embed fields from sections, replacing {{OVERLORDS}} token
  const fields: { name: string; value: string; inline?: boolean }[] = [];

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    let content = section.content;

    // Replace {{OVERLORDS}} token with the mentions string
    content = content.replace('{{OVERLORDS}}', overlordMentions || 'an officer');

    fields.push({
      name: section.title ?? '\u200b',
      value: content,
    });

    // Add spacer field between sections (but not after the last one)
    if (i < sections.length - 1) {
      fields.push({ name: '\u200b', value: '\u200b' });
    }
  }

  const embed = new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle('Recruitment')
    .addFields(fields);

  // Build Apply Here button
  const applicationUrlRow = db
    .prepare('SELECT value FROM config WHERE key = ?')
    .get('application_channel_url') as ConfigRow | undefined;

  const applyUrl = applicationUrlRow?.value || 'https://discord.com';

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel('Apply Here')
      .setStyle(ButtonStyle.Link)
      .setURL(applyUrl),
  );

  const message = await channel.send({
    embeds: [embed],
    components: [row],
    allowedMentions: { users: [] },
  });

  // Store message ID
  db.prepare('INSERT OR REPLACE INTO guild_info_messages (key, message_id) VALUES (?, ?)').run(
    'recruitment',
    message.id,
  );

  logger.info('guild-info', 'Posted Recruitment embed');
}

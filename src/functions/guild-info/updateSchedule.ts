import { type Client, EmbedBuilder, Colors } from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';
import { getOrCreateGuildInfoChannel } from './clearGuildInfo.js';
import type { ScheduleConfigRow, ScheduleDayRow } from '../../types/index.js';

/**
 * Post the Schedule embed to the guild info channel.
 */
export async function updateSchedule(client: Client): Promise<void> {
  const channel = await getOrCreateGuildInfoChannel(client);
  if (!channel) {
    logger.warn('guild-info', 'Could not resolve guild info channel for Schedule');
    return;
  }

  const db = getDatabase();

  // Get schedule config
  const titleRow = db.prepare('SELECT value FROM schedule_config WHERE key = ?').get('title') as ScheduleConfigRow | undefined;
  const timezoneRow = db.prepare('SELECT value FROM schedule_config WHERE key = ?').get('timezone') as ScheduleConfigRow | undefined;

  const title = titleRow?.value ?? 'Raid Schedule';
  const timezone = timezoneRow?.value ?? 'Server Time';

  // Get schedule days ordered by sort_order
  const days = db.prepare('SELECT * FROM schedule_days ORDER BY sort_order').all() as ScheduleDayRow[];

  if (days.length === 0) {
    logger.warn('guild-info', 'No schedule days found');
    return;
  }

  // Build embed with 3 inline fields: Day, spacer, Time
  const embed = new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle(title)
    .addFields(
      { name: 'Day', value: days.map((d) => d.day).join('\n'), inline: true },
      { name: '\u200b', value: days.map(() => '\u200b').join('\n'), inline: true },
      { name: 'Time', value: days.map((d) => d.time).join('\n'), inline: true },
    )
    .setFooter({ text: timezone });

  const message = await channel.send({ embeds: [embed] });

  // Store message ID
  db.prepare('INSERT OR REPLACE INTO guild_info_messages (key, message_id) VALUES (?, ?)').run(
    'schedule',
    message.id,
  );

  logger.info('guild-info', 'Posted Schedule embed');
}

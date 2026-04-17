import { type Client, type TextChannel, ChannelType } from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { getUpcomingRaids } from '../../services/wowaudit.js';
import { logger } from '../../services/logger.js';
import { config } from '../../config.js';
import type { ConfigRow, RaiderRow, SettingRow, SignupMessageRow } from '../../types/index.js';

interface DayConfig {
  settingKey: string;
  raidDay: string;
  twoDayReminder: boolean;
}

const DAY_MAP: Record<number, DayConfig> = {
  1: { settingKey: 'alertSignup_Wednesday_48', raidDay: 'Wednesday', twoDayReminder: true },
  2: { settingKey: 'alertSignup_Wednesday', raidDay: 'Wednesday', twoDayReminder: false },
  5: { settingKey: 'alertSignup_Sunday_48', raidDay: 'Sunday', twoDayReminder: true },
  6: { settingKey: 'alertSignup_Sunday', raidDay: 'Sunday', twoDayReminder: false },
};

async function getRaidersLoungeChannel(client: Client): Promise<TextChannel | null> {
  const db = getDatabase();

  const row = db
    .prepare('SELECT value FROM config WHERE key = ?')
    .get('raiders_lounge_channel_id') as ConfigRow | undefined;

  if (row) {
    try {
      const channel = await client.channels.fetch(row.value);
      if (channel && channel.type === ChannelType.GuildText) {
        return channel as TextChannel;
      }
    } catch {
      logger.warn('AlertSignups', 'Configured raiders-lounge channel not found, will auto-create');
    }
  }

  // Auto-create the channel
  try {
    const guild = await client.guilds.fetch(config.guildId);
    const channel = await guild.channels.create({
      name: 'raiders-lounge',
      type: ChannelType.GuildText,
      topic: 'Raider signup alerts and discussion',
    });

    db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(
      'raiders_lounge_channel_id',
      channel.id,
    );

    logger.info('AlertSignups', `Auto-created raiders-lounge channel: #${channel.name}`);
    return channel;
  } catch (error) {
    logger.error('AlertSignups', 'Failed to auto-create raiders-lounge channel', error as Error);
    return null;
  }
}

export async function alertSignups(client: Client): Promise<void> {
  const dayOfWeek = new Date().getDay();
  const dayConfig = DAY_MAP[dayOfWeek];

  if (!dayConfig) {
    logger.debug('AlertSignups', `No signup alert configured for day ${dayOfWeek}`);
    return;
  }

  const db = getDatabase();

  // Check if this alert setting is enabled
  const settingRow = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(dayConfig.settingKey) as SettingRow | undefined;

  if (!settingRow || settingRow.value === 0) {
    logger.debug('AlertSignups', `Setting ${dayConfig.settingKey} is disabled, skipping`);
    return;
  }

  // Fetch upcoming raids from WoW Audit
  let raids;
  try {
    raids = await getUpcomingRaids();
  } catch (error) {
    logger.error('AlertSignups', 'Failed to fetch upcoming raids from WoW Audit', error as Error);
    return;
  }

  // Find the next Mythic raid with status 'Planned'
  const nextRaid = raids.find(
    (r) => r.title.toLowerCase().includes('mythic') && r.note?.toLowerCase() !== 'cancelled',
  );

  if (!nextRaid) {
    logger.debug('AlertSignups', 'No upcoming Mythic raid found');
    return;
  }

  // Find unsigned raiders (status = 'Unknown')
  const unsignedCharacters = nextRaid.signups
    .filter((s) => s.status === 'Unknown')
    .map((s) => s.character.name.toLowerCase());

  if (unsignedCharacters.length === 0) {
    // Everyone has signed up!
    const channel = await getRaidersLoungeChannel(client);
    if (channel) {
      await channel.send('Everyone has signed for the next raid!');
    }
    logger.info('AlertSignups', 'All raiders have signed up for the next raid');
    return;
  }

  // Resolve Discord user IDs for unsigned raiders
  const raiders = db.prepare('SELECT * FROM raiders').all() as RaiderRow[];
  const raiderMap = new Map(raiders.map((r) => [r.character_name.toLowerCase(), r]));

  const mentions: string[] = [];
  for (const charName of unsignedCharacters) {
    const raider = raiderMap.get(charName);
    if (raider?.discord_user_id) {
      mentions.push(`<@${raider.discord_user_id}>`);
    } else {
      mentions.push(`**${charName}**`);
    }
  }

  // Pick a random signup message
  const messageRow = db
    .prepare('SELECT message FROM signup_messages ORDER BY RANDOM() LIMIT 1')
    .get() as SignupMessageRow | undefined;

  const randomMessage = messageRow?.message ?? 'Sign up for the next raid!';

  // Build the alert message
  let content = `${randomMessage}\n\nThe following raiders have not signed up for **${dayConfig.raidDay}**:\n${mentions.join(', ')}`;

  // For 48-hour reminders, add relative timestamp
  if (dayConfig.twoDayReminder) {
    const raidDate = new Date(nextRaid.date);
    const unixTimestamp = Math.floor(raidDate.getTime() / 1000);
    content += `\n\nRaid starts <t:${unixTimestamp}:R>`;
  }

  const channel = await getRaidersLoungeChannel(client);
  if (!channel) {
    logger.error('AlertSignups', 'Could not get raiders-lounge channel');
    return;
  }

  try {
    await channel.send(content);
    logger.info('AlertSignups', `Sent signup alert for ${dayConfig.raidDay} (${unsignedCharacters.length} unsigned)`);
  } catch (error) {
    logger.error('AlertSignups', 'Failed to send signup alert', error as Error);
  }
}

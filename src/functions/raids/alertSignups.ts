import { type Client, type TextChannel, ChannelType } from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { getUpcomingRaids, getRaid } from '../../services/wowaudit.js';
import { logger } from '../../services/logger.js';
import { config } from '../../config.js';
import { getOrCreateChannel } from '../channels.js';
import { generateSignupQuip } from '../../services/quipGenerator.js';
import { getProgressionContext, type ProgressionContext } from '../../services/quipContext.js';
import { getRecentQuips, recordQuip } from './quipHistory.js';
import { getOverlords } from './overlords.js';
import { resolveSignupMentions } from './resolveSignupMentions.js';
import type { SettingRow } from '../../types/index.js';

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

// The quip is one line, and the alert body already lists the unsigned raiders
// by name. Supply each optional detail only some of the time so consecutive
// reminders don't all lead with the same count / Overlord / progression line.
const COUNT_INCLUSION_CHANCE = 0.34;
const OVERLORD_INCLUSION_CHANCE = 0.34;
const PROGRESSION_INCLUSION_CHANCE = 0.5;

interface OptionalFlavour {
  overlordNames: string[];
  progression: ProgressionContext | null;
  unsignedCount?: number;
}

/**
 * Pick the optional quip context. `random` is injected so the decision is
 * testable without spying on the global `Math.random`.
 */
async function optionalFlavour(
  unsignedCount: number | undefined,
  random: () => number,
): Promise<OptionalFlavour> {
  const includeOverlords = random() < OVERLORD_INCLUSION_CHANCE;
  const includeProgression = random() < PROGRESSION_INCLUSION_CHANCE;
  const includedCount =
    unsignedCount !== undefined && random() < COUNT_INCLUSION_CHANCE ? unsignedCount : undefined;

  return {
    overlordNames: includeOverlords ? getOverlords().map((o) => o.name) : [],
    progression: includeProgression ? await getProgressionContext() : null,
    ...(includedCount !== undefined ? { unsignedCount: includedCount } : {}),
  };
}

async function getRaidersLoungeChannel(client: Client): Promise<TextChannel | null> {
  try {
    const guild = await client.guilds.fetch(config.guildId);
    const channel = await getOrCreateChannel(guild, {
      name: 'raiders-lounge',
      type: ChannelType.GuildText,
      categoryName: 'Raiders',
      configKey: 'raiders_lounge_channel_id',
      aliasNames: ['raiderslounge'],
      createOptions: { topic: 'Raider signup alerts and discussion' },
    });
    return channel;
  } catch (error) {
    logger.error('AlertSignups', 'Failed to resolve raiders-lounge channel', error as Error);
    return null;
  }
}

export async function alertSignups(
  client: Client,
  random: () => number = Math.random,
): Promise<void> {
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

  // Find the next upcoming Mythic raid that isn't cancelled.
  const nextRaid = raids.find((r) => r.difficulty === 'Mythic' && r.status !== 'Cancelled');

  if (!nextRaid) {
    logger.debug('AlertSignups', 'No upcoming Mythic raid found');
    return;
  }

  // Signups live on the per-raid endpoint, not the list returned above.
  let raidDetail;
  try {
    raidDetail = await getRaid(nextRaid.id);
  } catch (error) {
    logger.error('AlertSignups', 'Failed to fetch raid details from WoW Audit', error as Error);
    return;
  }

  // Find unsigned raiders (status 'Unknown' = no response yet)
  const unsignedCharacters = raidDetail.signups
    .filter((s) => s.status === 'Unknown')
    .map((s) => s.character.name);

  if (unsignedCharacters.length === 0) {
    // Everyone has signed up — celebrate with the same fresh quip machinery
    // used by ordinary reminders, so the message stays varied and relevant.
    const flavour = await optionalFlavour(undefined, random);
    const recentQuips = getRecentQuips(db);
    const { quip, generated } = await generateSignupQuip({
      raidDay: dayConfig.raidDay,
      twoDayReminder: dayConfig.twoDayReminder,
      allSignedUp: true,
      recentQuips,
      ...flavour,
    });
    const channel = await getRaidersLoungeChannel(client);
    if (channel) {
      await channel.send(quip);
      if (generated) {
        recordQuip(db, quip);
      }
    }
    logger.info('AlertSignups', 'All raiders have signed up for the next raid');
    return;
  }

  // Resolve Discord user IDs for unsigned raiders
  const mentions = resolveSignupMentions(db, unsignedCharacters);

  // Generate a fresh signup quip via the rotating LLM cascade, with raid
  // progression + recent-quip context. Progression is best-effort (null on
  // any raider.io hiccup) and never blocks the alert. Optional flavour is
  // rolled so the quip doesn't restate the same facts every reminder.
  const flavour = await optionalFlavour(unsignedCharacters.length, random);
  const recentQuips = getRecentQuips(db);

  const { quip, generated } = await generateSignupQuip({
    raidDay: dayConfig.raidDay,
    twoDayReminder: dayConfig.twoDayReminder,
    recentQuips,
    ...flavour,
  });

  // Build the alert message
  let content = `${quip}\n\nThe following raiders have not signed up for **${dayConfig.raidDay}**:\n${mentions.join(', ')}`;

  // For 48-hour reminders, add relative timestamp
  if (dayConfig.twoDayReminder) {
    const raidDate = new Date(`${nextRaid.date}T${nextRaid.start_time || '00:00'}:00`);
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
    // Only remember LLM-generated quips — the static corpus is meant to repeat.
    if (generated) {
      recordQuip(db, quip);
    }
    logger.info(
      'AlertSignups',
      `Sent signup alert for ${dayConfig.raidDay} (${unsignedCharacters.length} unsigned)`,
    );
  } catch (error) {
    logger.error('AlertSignups', 'Failed to send signup alert', error as Error);
  }
}

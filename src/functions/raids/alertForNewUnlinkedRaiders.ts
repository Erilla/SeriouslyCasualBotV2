import type { Client } from 'discord.js';
import { config } from '../../config.js';
import { logger } from '../../services/logger.js';
import type { RaiderRow } from '../../types/index.js';
import { autoMatchRaiders } from './autoMatchRaiders.js';
import { sendAlertForRaidersWithNoUser } from './sendAlertForRaidersWithNoUser.js';

/**
 * Post auto-link suggestions / missing-user alerts for raiders that a roster
 * sync just added without a Discord user. Wiring this after each sync is what
 * makes linking alerts appear automatically (V2 spec: "when a new raider is
 * added without a Discord user ... the bot attempts to auto-match").
 *
 * Best-effort: failures are logged, never thrown, so they can't fail the
 * surrounding sync/scheduled task.
 */
export async function alertForNewUnlinkedRaiders(
  client: Client,
  newRaiders: RaiderRow[],
): Promise<void> {
  if (newRaiders.length === 0) return;

  const guild =
    client.guilds.cache.get(config.guildId) ??
    (await client.guilds.fetch(config.guildId).catch(() => null));

  if (!guild) {
    logger.error(
      'RaiderAlerts',
      'Failed to resolve guild for new-raider linking alerts',
      new Error(`guild ${config.guildId} not in cache and fetch failed`),
    );
    return;
  }

  const matches = await autoMatchRaiders(guild, newRaiders);
  await sendAlertForRaidersWithNoUser(client, newRaiders, matches);
}

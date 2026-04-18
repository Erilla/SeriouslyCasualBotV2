import type { Client } from 'discord.js';
import type Database from 'better-sqlite3';
import type { RaiderRow } from '../../../types/index.js';
import { logger } from '../../../services/logger.js';
import { seedRaiders } from '../seedRaiders.js';
import { sendAlertForRaidersWithNoUser } from '../../raids/sendAlertForRaidersWithNoUser.js';

export interface SeedRaidersDiscordResult {
  raidersSeeded: number;
  linkingMessagesRequested: number;
  skippedReason?: string;
}

/**
 * DB-only seedRaiders + posts raider-setup linking messages for any unlinked
 * raiders missing a message_id. The setup channel is auto-created if not configured.
 */
export async function seedRaidersDiscord(
  client: Client,
  db: Database.Database,
): Promise<SeedRaidersDiscordResult> {
  seedRaiders(db);

  const unlinked = db
    .prepare('SELECT * FROM raiders WHERE discord_user_id IS NULL AND message_id IS NULL')
    .all() as RaiderRow[];

  const raidersSeeded = (db.prepare('SELECT COUNT(*) as c FROM raiders').get() as { c: number }).c;

  if (unlinked.length === 0) {
    return { raidersSeeded, linkingMessagesRequested: 0, skippedReason: 'all raiders already linked or have messages' };
  }

  try {
    await sendAlertForRaidersWithNoUser(client, unlinked, []);
    return { raidersSeeded, linkingMessagesRequested: unlinked.length };
  } catch (error) {
    logger.error('TestData', 'Failed to send linking messages', error as Error);
    return {
      raidersSeeded,
      linkingMessagesRequested: 0,
      skippedReason: `linking messages failed: ${(error as Error).message}`,
    };
  }
}

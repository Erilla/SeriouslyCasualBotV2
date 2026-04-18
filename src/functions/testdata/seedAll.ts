import type { Client } from 'discord.js';
import type Database from 'better-sqlite3';
import { logger } from '../../services/logger.js';
import { seedRaiders } from './seedRaiders.js';
import { seedApplicationQuestions } from './seedApplicationQuestions.js';
import { seedApplication } from './seedApplication.js';
import { seedTrial } from './seedTrial.js';
import { seedEpgp } from './seedEpgp.js';
import { seedLoot } from './seedLoot.js';
import { seedRaidersDiscord } from './discord/seedRaidersDiscord.js';
import { seedApplicationDiscord } from './discord/seedApplicationDiscord.js';
import { seedTrialDiscord } from './discord/seedTrialDiscord.js';
import { seedLootDiscord } from './discord/seedLootDiscord.js';

export interface SeedAllOptions {
  client?: Client;
}

export interface SeedAllResult {
  discord: boolean;
  raidersSeeded: number;
  applicationId: number | null;
  trialId: number | null;
  epgpSeeded: boolean;
  lootPostsInDb: number;
  lootDiscordMessagesPosted: number;
  skipped: string[];
}

/**
 * Runs all seeds in order, reporting per-step failures instead of aborting.
 * When options.client is provided, each sub-seed uses its Discord variant.
 * The trial is linked to the seeded application via application_id when both exist.
 *
 * Error model: fail-soft. Every step is caught individually; failures are recorded
 * in `skipped`. A failure in one step does not prevent subsequent steps from running.
 */
export async function seedAll(db: Database.Database, options: SeedAllOptions = {}): Promise<SeedAllResult> {
  const discord = Boolean(options.client);
  const skipped: string[] = [];

  let raidersSeeded = 0;
  try {
    if (options.client) {
      const r = await seedRaidersDiscord(options.client, db);
      raidersSeeded = r.raidersSeeded;
      if (r.skippedReason) skipped.push(`raiders: ${r.skippedReason}`);
    } else {
      seedRaiders(db);
      raidersSeeded = (db.prepare('SELECT COUNT(*) as c FROM raiders').get() as { c: number }).c;
    }
  } catch (error) {
    skipped.push(`raiders: ${(error as Error).message}`);
  }

  try {
    seedApplicationQuestions(db);
  } catch (error) {
    skipped.push(`application_questions: ${(error as Error).message}`);
  }

  let applicationId: number | null = null;
  try {
    if (options.client) {
      const r = await seedApplicationDiscord(options.client, db);
      applicationId = r.applicationId;
      if (r.skippedReason) skipped.push(`application: ${r.skippedReason}`);
    } else {
      const r = seedApplication(db);
      applicationId = r.applicationId;
    }
  } catch (error) {
    skipped.push(`application: ${(error as Error).message}`);
  }

  let trialId: number | null = null;
  try {
    if (options.client) {
      const r = await seedTrialDiscord(options.client, { applicationId: applicationId ?? undefined });
      trialId = r.trialId;
      if (r.skippedReason) skipped.push(`trial: ${r.skippedReason}`);
    } else {
      const r = seedTrial(db, { applicationId: applicationId ?? undefined });
      trialId = r.trialId;
    }
  } catch (error) {
    skipped.push(`trial: ${(error as Error).message}`);
  }

  let epgpSeeded = false;
  try {
    seedEpgp(db);
    epgpSeeded = true;
  } catch (error) {
    skipped.push(`epgp: ${(error as Error).message}`);
  }

  let lootPostsInDb = 0;
  let lootDiscordMessagesPosted = 0;
  try {
    if (options.client) {
      const r = await seedLootDiscord(options.client, db);
      lootPostsInDb = r.dbPostsInserted;
      lootDiscordMessagesPosted = r.postsCreated;
      if (r.skippedReason) skipped.push(`loot: ${r.skippedReason}`);
    } else {
      const r = seedLoot(db);
      lootPostsInDb = r.postsInserted;
    }
  } catch (error) {
    skipped.push(`loot: ${(error as Error).message}`);
  }

  logger.info('TestData', `seedAll complete — discord=${discord}, skipped=${skipped.length}`);

  return {
    discord,
    raidersSeeded,
    applicationId,
    trialId,
    epgpSeeded,
    lootPostsInDb,
    lootDiscordMessagesPosted,
    skipped,
  };
}

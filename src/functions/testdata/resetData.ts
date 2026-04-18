import type { Client } from 'discord.js';
import type Database from 'better-sqlite3';
import { seedDatabase } from '../../database/seed.js';
import { seedApplicationQuestions } from './seedApplicationQuestions.js';
import { resetDiscordArtifacts, type ResetArtifactsResult } from './resetDiscordArtifacts.js';

export class ResetDiscordError extends Error {
  readonly result: ResetArtifactsResult;
  constructor(result: ResetArtifactsResult) {
    const summary = result.errors
      .slice(0, 5)
      .map((e) => `${e.kind}(${e.id}): ${e.message}`)
      .join('; ');
    const more = result.errors.length > 5 ? ` (+${result.errors.length - 5} more)` : '';
    super(`Discord cleanup failed for ${result.errors.length} artifact(s): ${summary}${more}`);
    this.name = 'ResetDiscordError';
    this.result = result;
  }
}

export interface ResetDataResult {
  discord: ResetArtifactsResult | null;
}

/**
 * Wipes all data from all tables in correct FK order (children before parents),
 * then re-seeds defaults via seedDatabase() and the 9 default application questions.
 *
 * When `client` is provided, Discord artifacts (forum threads, per-app channels,
 * loot messages, linking messages, guild-info messages) are torn down FIRST.
 * If Discord cleanup reports any real errors (anything other than 404-style
 * "already gone"), the DB wipe is aborted and ResetDiscordError is thrown —
 * this preserves the "consistent state" invariant from #30: we never leave
 * the DB wiped with Discord artifacts still dangling.
 */
export async function resetData(
  db: Database.Database,
  client?: Client,
): Promise<ResetDataResult> {
  let discord: ResetArtifactsResult | null = null;
  if (client) {
    discord = await resetDiscordArtifacts(client, db);
    if (discord.errors.length > 0) {
      throw new ResetDiscordError(discord);
    }
  }

  const tx = db.transaction(() => {
    // Children first to satisfy FK constraints.
    // trials.application_id → applications.id, so the whole trial chain
    // must be gone before we touch applications.
    db.prepare('DELETE FROM trial_alerts').run();
    db.prepare('DELETE FROM promote_alerts').run();
    db.prepare('DELETE FROM trials').run();

    db.prepare('DELETE FROM application_answers').run();
    db.prepare('DELETE FROM application_votes').run();
    db.prepare('DELETE FROM applications').run();
    db.prepare('DELETE FROM application_questions').run();

    db.prepare('DELETE FROM loot_responses').run();
    db.prepare('DELETE FROM loot_posts').run();

    db.prepare('DELETE FROM epgp_loot_history').run();
    db.prepare('DELETE FROM epgp_effort_points').run();
    db.prepare('DELETE FROM epgp_gear_points').run();
    db.prepare('DELETE FROM epgp_upload_history').run();
    db.prepare('DELETE FROM epgp_config').run();

    db.prepare('DELETE FROM raiders').run();
    db.prepare('DELETE FROM raider_identity_map').run();
    db.prepare('DELETE FROM overlords').run();
    db.prepare('DELETE FROM ignored_characters').run();

    db.prepare('DELETE FROM guild_info_messages').run();
    db.prepare('DELETE FROM guild_info_content').run();
    db.prepare('DELETE FROM guild_info_links').run();

    db.prepare('DELETE FROM schedule_days').run();
    db.prepare('DELETE FROM schedule_config').run();

    db.prepare('DELETE FROM achievements_manual').run();
    db.prepare('DELETE FROM signup_messages').run();
    db.prepare('DELETE FROM default_messages').run();
    db.prepare('DELETE FROM settings').run();
    db.prepare('DELETE FROM config').run();
  });

  tx();

  // Re-seed defaults outside the delete transaction. If seedDatabase throws, the
  // tables will be empty — acceptable for a dev-only command since /testdata reset
  // can simply be re-run, but worth knowing if you're debugging a half-seeded state.
  //
  // seedApplicationQuestions is idempotent; seedDatabase does not currently own the
  // 9 default application questions, so we call this explicitly here. If that ever
  // changes, consolidate into one call site to avoid two sources of truth.
  seedDatabase(db);
  seedApplicationQuestions(db);

  return { discord };
}

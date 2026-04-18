import type Database from 'better-sqlite3';
import { seedDatabase } from '../../database/seed.js';

/**
 * Wipes all data from all tables in correct FK order (children before parents),
 * then re-seeds defaults via seedDatabase().
 */
export function resetData(db: Database.Database): void {
  const tx = db.transaction(() => {
    // Children first to satisfy FK constraints
    db.prepare('DELETE FROM application_answers').run();
    db.prepare('DELETE FROM application_votes').run();
    db.prepare('DELETE FROM applications').run();
    db.prepare('DELETE FROM application_questions').run();

    db.prepare('DELETE FROM trial_alerts').run();
    db.prepare('DELETE FROM promote_alerts').run();
    db.prepare('DELETE FROM trials').run();

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
  seedDatabase(db);
}

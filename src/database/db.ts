import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { createTables } from './schema.js';
import { seedDatabase } from './seed.js';
import { seedApplicationQuestions } from './seedApplicationQuestions.js';

let db: Database.Database | null = null;

export function getDatabase(path?: string): Database.Database {
  if (db) return db;

  const dbPath = path || process.env.DB_PATH || 'db.sqlite';
  // better-sqlite3 won't create the parent directory. When DB_PATH points at a
  // mounted volume (e.g. /app/data/db.sqlite on Railway), the dir may not exist
  // yet, so create it ourselves. dirname('db.sqlite') === '.', a harmless no-op.
  mkdirSync(dirname(dbPath), { recursive: true });
  db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  return db;
}

export function initDatabase(path?: string): Database.Database {
  const database = getDatabase(path);
  createTables(database);
  runMigrations(database);
  seedDatabase(database);
  // Ensure the default application questions exist. seedDatabase early-returns
  // once guild_info_content is populated, so this is called separately and is
  // idempotent on its own (no-ops when application_questions is non-empty).
  seedApplicationQuestions(database);
  return database;
}

export function runMigrations(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = database
    .prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')
    .get() as { version: number } | undefined;

  const currentVersion = applied?.version ?? 0;

  if (currentVersion < 1) {
    database.prepare('INSERT INTO schema_version (version) VALUES (?)').run(1);
  }

  if (currentVersion < 2) {
    const oldRow = database
      .prepare("SELECT value FROM config WHERE key = 'epgp_channel_id'")
      .get() as { value: string } | undefined;
    const newRow = database
      .prepare("SELECT value FROM config WHERE key = 'epgp_rankings_channel_id'")
      .get() as { value: string } | undefined;

    if (oldRow && newRow && oldRow.value !== newRow.value) {
      // Both keys set to different values — keep the new, drop the old, but
      // log the conflict so an operator can investigate if this was unexpected.
      console.warn(
        `[db migration v2] Both epgp_channel_id ("${oldRow.value}") and ` +
          `epgp_rankings_channel_id ("${newRow.value}") are set. Keeping ` +
          `epgp_rankings_channel_id and dropping the old key.`,
      );
    }

    // better-sqlite3's .transaction() returns a function we must invoke — the
    // trailing () runs the block in an atomic transaction. Omitting () would
    // define the transaction but never execute it.
    database.transaction(() => {
      database.exec(`
        INSERT OR IGNORE INTO config (key, value)
          SELECT 'epgp_rankings_channel_id', value
          FROM config
          WHERE key = 'epgp_channel_id';
        DELETE FROM config WHERE key = 'epgp_channel_id';
      `);
      database.prepare('INSERT INTO schema_version (version) VALUES (?)').run(2);
    })();
  }

  if (currentVersion < 3) {
    // Drop the signup_messages table. Quips are now generated on demand by
    // the Gemini quip generator (#27); the table was never seeded in V2 so
    // no data loss for anyone coming through a V2 install. Kept as
    // DROP IF EXISTS to stay safe on fresh DBs where createTables ran
    // after this migration was written.
    database.transaction(() => {
      database.exec(`DROP TABLE IF EXISTS signup_messages;`);
      database.prepare('INSERT INTO schema_version (version) VALUES (?)').run(3);
    })();
  }

  if (currentVersion < 4) {
    // Drop the EPGP feature entirely — it's no longer used. Removes the five
    // EPGP tables and the now-orphaned channel config key (the epgp-rankings
    // channel is no longer bootstrapped). DROP IF EXISTS keeps this safe on
    // fresh DBs where createTables (which no longer defines these tables) ran
    // before this migration. This supersedes the v2 key migration above.
    database.transaction(() => {
      database.exec(`
        DROP TABLE IF EXISTS epgp_loot_history;
        DROP TABLE IF EXISTS epgp_effort_points;
        DROP TABLE IF EXISTS epgp_gear_points;
        DROP TABLE IF EXISTS epgp_upload_history;
        DROP TABLE IF EXISTS epgp_config;
        DELETE FROM config WHERE key IN ('epgp_channel_id', 'epgp_rankings_channel_id');
      `);
      database.prepare('INSERT INTO schema_version (version) VALUES (?)').run(4);
    })();
  }

  if (currentVersion < 5) {
    // Retire long-missing raiders to an inactive state. Add the
    // inactive_since column. Fresh DBs already have it from createTables, so
    // guard the ALTER against a duplicate-column error and keep the migration
    // idempotent.
    database.transaction(() => {
      const cols = database.pragma('table_info(raiders)') as { name: string }[];
      if (!cols.some((c) => c.name === 'inactive_since')) {
        database.exec('ALTER TABLE raiders ADD COLUMN inactive_since TEXT');
      }
      database.prepare('INSERT INTO schema_version (version) VALUES (?)').run(5);
    })();
  }

  if (currentVersion < 6) {
    // The officer role is no longer a /setup value — it's fixed at boot via the
    // OFFICER_ROLE_ID env var, which is the single source of truth for both
    // permission checks and officer-alert pings. Drop the now-orphaned config
    // key so it stops showing under get_config's "unknown keys". Harmless on
    // DBs that never set it.
    database.transaction(() => {
      database.exec("DELETE FROM config WHERE key = 'officer_role_id';");
      database.prepare('INSERT INTO schema_version (version) VALUES (?)').run(6);
    })();
  }

  if (currentVersion < 7) {
    // Anti-repetition memory for signup quips: recent generated quips are fed
    // back into the LLM prompt as "don't resemble these". Fresh DBs get the
    // table from createTables; IF NOT EXISTS keeps this idempotent there.
    database.transaction(() => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS quip_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          quip TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      database.prepare('INSERT INTO schema_version (version) VALUES (?)').run(7);
    })();
  }

  if (currentVersion < 8) {
    // Cache for the startup build number: maps a deployed commit SHA to its
    // commit count so each build makes at most one GitHub API call across
    // restarts. Fresh DBs get the table from createTables; IF NOT EXISTS
    // keeps this idempotent there.
    database.transaction(() => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS build_info (
          sha   TEXT PRIMARY KEY,
          build INTEGER NOT NULL
        );
      `);
      database.prepare('INSERT INTO schema_version (version) VALUES (?)').run(8);
    })();
  }
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

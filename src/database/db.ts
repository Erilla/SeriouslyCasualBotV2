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

  if (currentVersion < 9) {
    // Achievements image v2: cache tables for Raider.IO payloads + zamimg
    // icons, plus a per-row icon on the manual achievements. Fresh DBs get
    // the tables/column from createTables; the guards keep this idempotent.
    database.transaction(() => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS api_cache (
          key TEXT PRIMARY KEY,
          payload TEXT NOT NULL,
          fetched_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS icon_cache (
          name TEXT PRIMARY KEY,
          image BLOB NOT NULL,
          fetched_at TEXT NOT NULL
        );
      `);
      const tableExists = database
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='achievements_manual'")
        .get();
      if (tableExists) {
        const cols = database.pragma('table_info(achievements_manual)') as { name: string }[];
        if (!cols.some((c) => c.name === 'icon')) {
          database.exec('ALTER TABLE achievements_manual ADD COLUMN icon TEXT');
        }
        // Backfill icons for the known manual rows (no-op if renamed/absent).
        const setIcon = database.prepare(
          'UPDATE achievements_manual SET icon = ? WHERE raid = ? AND icon IS NULL',
        );
        setIcon.run('achievement_boss_garrosh', 'Siege of Orgrimmar (10 man)');
        setIcon.run('achievement_boss_highmaul_king', 'Highmaul');
        setIcon.run('achievement_boss_blackhand', 'Blackrock Foundry');
        setIcon.run('achievement_boss_hellfire_archimonde', 'Hellfire Citadel');
      }
      database.prepare('INSERT INTO schema_version (version) VALUES (?)').run(9);
    })();
  }

  if (currentVersion < 10) {
    // Officer-managed CE cutoffs are persistent business data, deliberately
    // separate from the achievements API/icon cache tables.
    database.transaction(() => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS achievement_ce_overrides (
          raid_slug TEXT PRIMARY KEY,
          cutoff_at TEXT NOT NULL
        );
      `);
      database.prepare('INSERT INTO schema_version (version) VALUES (?)').run(10);
    })();
  }

  if (currentVersion < 11) {
    // Applicant intel: a resumable background sweep needs its progress on disk
    // so a rate-limit pause or a restart costs time, not work. Fresh DBs get
    // these from createTables; IF NOT EXISTS keeps this idempotent there.
    database.transaction(() => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS applicant_intel_jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          application_id INTEGER,
          target_channel_id TEXT,
          character_name TEXT NOT NULL,
          character_realm TEXT NOT NULL,
          character_region TEXT NOT NULL,
          phase TEXT NOT NULL DEFAULT 'logs',
          status TEXT NOT NULL DEFAULT 'pending',
          resume_after TEXT,
          paused_service TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          logs_message_id TEXT,
          alts_message_id TEXT,
          guilds_message_id TEXT,
          applicant_discord TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS applicant_intel_queue (
          job_id INTEGER NOT NULL,
          kind TEXT NOT NULL,
          key TEXT NOT NULL,
          payload TEXT,
          done INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (job_id, kind, key)
        );
        CREATE TABLE IF NOT EXISTS applicant_intel_scanned (
          job_id INTEGER NOT NULL,
          character_key TEXT NOT NULL,
          PRIMARY KEY (job_id, character_key)
        );
        CREATE TABLE IF NOT EXISTS applicant_intel_findings (
          job_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          realm TEXT NOT NULL,
          class TEXT,
          guild_name TEXT,
          guild_realm TEXT,
          source TEXT NOT NULL,
          confidence REAL,
          discord_status TEXT,
          discord_profile TEXT,
          PRIMARY KEY (job_id, name, realm)
        );
      `);
      database.prepare('INSERT INTO schema_version (version) VALUES (?)').run(11);
    })();
  }

  if (currentVersion < 12) {
    // Applicant departures: overlords are told once when the Discord user behind
    // an undecided application leaves. The marker has to be durable, because the
    // gateway event is missed on every redeploy and the startup sweep that
    // catches up would otherwise re-notify on each boot.
    //
    // Fresh databases already have the column from createTables, so guard on
    // table_info rather than letting a duplicate ALTER throw. The table itself
    // may also be absent — table_info returns [] for a missing table, so check
    // sqlite_master first or the ALTER throws (same shape as v9).
    database.transaction(() => {
      const tableExists = database
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='applications'")
        .get();
      if (tableExists) {
        const cols = database.pragma('table_info(applications)') as { name: string }[];
        if (!cols.some((c) => c.name === 'departed_notified_at')) {
          database.exec('ALTER TABLE applications ADD COLUMN departed_notified_at TEXT');
        }
      }
      database.prepare('INSERT INTO schema_version (version) VALUES (?)').run(12);
    })();
  }
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

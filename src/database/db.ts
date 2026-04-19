import Database from 'better-sqlite3';
import { createTables } from './schema.js';
import { seedDatabase } from './seed.js';

let db: Database.Database | null = null;

export function getDatabase(path?: string): Database.Database {
  if (db) return db;

  const dbPath = path || process.env.DB_PATH || 'db.sqlite';
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
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

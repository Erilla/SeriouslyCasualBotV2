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
    // Rename epgp_channel_id -> epgp_rankings_channel_id to match /setup's config key.
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
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

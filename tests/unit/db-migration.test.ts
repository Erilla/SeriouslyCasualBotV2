import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDatabase, closeDatabase, runMigrations, initDatabase } from '../../src/database/db.js';
import { createTables } from '../../src/database/schema.js';

beforeEach(() => {
  closeDatabase();
  const db = getDatabase(':memory:');
  createTables(db);
});

afterEach(() => {
  closeDatabase();
});

describe('runMigrations — v4 removes the EPGP feature', () => {
  it('drops the EPGP tables left over from a prior install', () => {
    const db = getDatabase();

    // Recreate the legacy EPGP tables — createTables no longer defines them,
    // so we manually seed the pre-migration shape to represent an existing
    // install still carrying them.
    db.exec(`
      CREATE TABLE IF NOT EXISTS epgp_effort_points (id INTEGER PRIMARY KEY AUTOINCREMENT);
      CREATE TABLE IF NOT EXISTS epgp_gear_points (id INTEGER PRIMARY KEY AUTOINCREMENT);
      CREATE TABLE IF NOT EXISTS epgp_upload_history (id INTEGER PRIMARY KEY AUTOINCREMENT);
      CREATE TABLE IF NOT EXISTS epgp_loot_history (id INTEGER PRIMARY KEY AUTOINCREMENT);
      CREATE TABLE IF NOT EXISTS epgp_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    // Clear schema_version so migrations re-apply against the legacy tables.
    db.exec('DELETE FROM schema_version;');

    runMigrations(db);

    const epgpTables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'epgp_%'`)
      .all();
    expect(epgpTables).toEqual([]);

    const version = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as {
      v: number;
    };
    expect(version.v).toBeGreaterThanOrEqual(4);
  });

  it('deletes leftover EPGP channel config keys', () => {
    const db = getDatabase();
    db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run('epgp_channel_id', 'chan-123');
    db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run(
      'epgp_rankings_channel_id',
      'chan-456',
    );
    db.exec('DELETE FROM schema_version;');

    runMigrations(db);

    expect(
      db.prepare('SELECT value FROM config WHERE key = ?').get('epgp_channel_id'),
    ).toBeUndefined();
    expect(
      db.prepare('SELECT value FROM config WHERE key = ?').get('epgp_rankings_channel_id'),
    ).toBeUndefined();
  });

  it('is a no-op when EPGP tables are already gone', () => {
    const db = getDatabase();

    expect(() => runMigrations(db)).not.toThrow();
    expect(() => runMigrations(db)).not.toThrow();
  });
});

describe('runMigrations — v5 adds inactive_since to raiders', () => {
  it('adds the column to a legacy raiders table missing it', () => {
    const db = getDatabase();

    // Represent a pre-v5 install: recreate raiders WITHOUT inactive_since.
    db.exec('DROP TABLE raiders;');
    db.exec(`
      CREATE TABLE raiders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        character_name TEXT NOT NULL UNIQUE,
        realm TEXT DEFAULT 'silvermoon',
        region TEXT DEFAULT 'eu',
        rank INTEGER,
        class TEXT,
        discord_user_id TEXT,
        message_id TEXT,
        missing_since TEXT
      );
    `);
    db.exec('DELETE FROM schema_version;');

    runMigrations(db);

    const cols = db.pragma('table_info(raiders)') as { name: string }[];
    expect(cols.some((c) => c.name === 'inactive_since')).toBe(true);

    const version = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as {
      v: number;
    };
    expect(version.v).toBeGreaterThanOrEqual(5);
  });

  it('is a no-op on a fresh DB where the column already exists', () => {
    const db = getDatabase(); // beforeEach already ran createTables (column present)

    expect(() => runMigrations(db)).not.toThrow();
    expect(() => runMigrations(db)).not.toThrow();

    const cols = db.pragma('table_info(raiders)') as { name: string }[];
    expect(cols.filter((c) => c.name === 'inactive_since')).toHaveLength(1);
  });
});

describe('runMigrations — v3 drops signup_messages', () => {
  it('drops the signup_messages table if it exists from a prior install', () => {
    const db = getDatabase();

    // Recreate the legacy table — createTables no longer includes it (#27),
    // so we manually seed the pre-migration shape to represent an existing
    // install carrying the old table.
    db.exec(`CREATE TABLE IF NOT EXISTS signup_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message TEXT NOT NULL
    );`);
    db.prepare('INSERT INTO signup_messages (message) VALUES (?)').run('legacy');

    // Clear schema_version so migrations from v1 are re-applied (we want v3 to
    // run against this pre-existing table).
    db.exec('DELETE FROM schema_version;');

    runMigrations(db);

    const tableExists = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='signup_messages'`)
      .get();
    expect(tableExists).toBeUndefined();

    const version = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as {
      v: number;
    };
    expect(version.v).toBeGreaterThanOrEqual(3);
  });

  it('is a no-op when signup_messages is already gone', () => {
    const db = getDatabase();

    expect(() => runMigrations(db)).not.toThrow();
    expect(() => runMigrations(db)).not.toThrow();
  });
});

describe('runMigrations — v6 drops the orphaned officer_role_id config key', () => {
  it('deletes an officer_role_id row left over from the old /setup flow', () => {
    const db = getDatabase();

    // Represent a pre-v6 install that had set the officer role via /setup.
    db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run('officer_role_id', 'role-123');
    db.exec('DELETE FROM schema_version;');

    runMigrations(db);

    expect(
      db.prepare('SELECT value FROM config WHERE key = ?').get('officer_role_id'),
    ).toBeUndefined();

    const version = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as {
      v: number;
    };
    expect(version.v).toBeGreaterThanOrEqual(6);
  });

  it('leaves other role config (raider_role_id) untouched', () => {
    const db = getDatabase();

    db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run('raider_role_id', 'role-456');
    db.exec('DELETE FROM schema_version;');

    runMigrations(db);

    expect(db.prepare('SELECT value FROM config WHERE key = ?').get('raider_role_id')).toEqual({
      value: 'role-456',
    });
  });

  it('is a no-op when officer_role_id was never set', () => {
    const db = getDatabase();

    expect(() => runMigrations(db)).not.toThrow();
    expect(() => runMigrations(db)).not.toThrow();
  });
});

describe('runMigrations — v8 adds the build_info cache table', () => {
  it('creates build_info on a legacy DB missing it', () => {
    const db = getDatabase();

    // Represent a pre-v8 install: createTables in beforeEach created the
    // table, so drop it and replay migrations.
    db.exec('DROP TABLE IF EXISTS build_info;');
    db.exec('DELETE FROM schema_version;');

    runMigrations(db);

    const table = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='build_info'`)
      .get();
    expect(table).toBeDefined();

    const version = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as {
      v: number;
    };
    expect(version.v).toBeGreaterThanOrEqual(8);
  });

  it('is a no-op on a fresh DB where the table already exists', () => {
    const db = getDatabase();

    expect(() => runMigrations(db)).not.toThrow();
    expect(() => runMigrations(db)).not.toThrow();

    const table = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='build_info'`)
      .get();
    expect(table).toBeDefined();
  });
});

describe('initDatabase — seeds default application questions', () => {
  it('seeds the 9 default application questions on a fresh database', () => {
    const db = initDatabase(':memory:');

    const count = (
      db.prepare('SELECT COUNT(*) as count FROM application_questions').get() as { count: number }
    ).count;
    expect(count).toBe(9);
  });

  it('is idempotent — re-running initDatabase does not duplicate questions', () => {
    initDatabase(':memory:');
    const db = initDatabase(':memory:');

    const count = (
      db.prepare('SELECT COUNT(*) as count FROM application_questions').get() as { count: number }
    ).count;
    expect(count).toBe(9);
  });
});

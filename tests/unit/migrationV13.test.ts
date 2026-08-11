import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/database/db.js';

/**
 * A pre-v13 database: the trials table as it was, without either new column, plus
 * the two tables the back-fill reads from.
 */
function preV13(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
    INSERT INTO schema_version (version) VALUES (12);
    CREATE TABLE applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      applicant_user_id TEXT,
      status TEXT
    );
    CREATE TABLE raiders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_name TEXT NOT NULL UNIQUE,
      discord_user_id TEXT
    );
    CREATE TABLE trials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_name TEXT NOT NULL,
      role TEXT NOT NULL,
      start_date TEXT NOT NULL,
      thread_id TEXT,
      logs_message_id TEXT,
      application_id INTEGER REFERENCES applications(id),
      status TEXT DEFAULT 'active'
    );
  `);
  return db;
}

function trialColumns(db: Database.Database): string[] {
  return (db.pragma('table_info(trials)') as { name: string }[]).map((c) => c.name);
}

describe('migration v13 — trial departure columns', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = preV13();
  });
  afterEach(() => db.close());

  it('adds both columns', () => {
    runMigrations(db);

    expect(trialColumns(db)).toContain('discord_user_id');
    expect(trialColumns(db)).toContain('departed_notified_at');
  });

  it('back-fills discord_user_id from the linked application', () => {
    db.prepare(
      "INSERT INTO applications (id, applicant_user_id, status) VALUES (7, 'u-app', 'accepted')",
    ).run();
    db.prepare(
      `INSERT INTO trials (character_name, role, start_date, application_id)
       VALUES ('Fromapp', 'dps', '2026-08-01', 7)`,
    ).run();

    runMigrations(db);

    const row = db
      .prepare('SELECT discord_user_id FROM trials WHERE character_name = ?')
      .get('Fromapp');
    expect(row).toEqual({ discord_user_id: 'u-app' });
  });

  it('back-fills discord_user_id from raiders when there is no application link', () => {
    db.prepare(
      "INSERT INTO raiders (character_name, discord_user_id) VALUES ('Fromraider', 'u-raider')",
    ).run();
    db.prepare(
      `INSERT INTO trials (character_name, role, start_date) VALUES ('Fromraider', 'heal', '2026-08-01')`,
    ).run();

    runMigrations(db);

    const row = db
      .prepare('SELECT discord_user_id FROM trials WHERE character_name = ?')
      .get('Fromraider');
    expect(row).toEqual({ discord_user_id: 'u-raider' });
  });

  it('prefers the application link over a conflicting raiders row', () => {
    db.prepare(
      "INSERT INTO applications (id, applicant_user_id, status) VALUES (8, 'u-app', 'accepted')",
    ).run();
    db.prepare(
      "INSERT INTO raiders (character_name, discord_user_id) VALUES ('Both', 'u-raider')",
    ).run();
    db.prepare(
      `INSERT INTO trials (character_name, role, start_date, application_id)
       VALUES ('Both', 'dps', '2026-08-01', 8)`,
    ).run();

    runMigrations(db);

    const row = db
      .prepare('SELECT discord_user_id FROM trials WHERE character_name = ?')
      .get('Both');
    expect(row).toEqual({ discord_user_id: 'u-app' });
  });

  it('leaves a genuinely unknown trial NULL rather than guessing', () => {
    db.prepare(
      `INSERT INTO trials (character_name, role, start_date) VALUES ('Nobody', 'dps', '2026-08-01')`,
    ).run();

    runMigrations(db);

    const row = db
      .prepare('SELECT discord_user_id FROM trials WHERE character_name = ?')
      .get('Nobody');
    expect(row).toEqual({ discord_user_id: null });
  });

  it('leaves a closed trial NULL: the back-fill is scoped to active trials', () => {
    db.prepare(
      "INSERT INTO raiders (character_name, discord_user_id) VALUES ('Closed', 'u-raider')",
    ).run();
    db.prepare(
      `INSERT INTO trials (character_name, role, start_date, status)
       VALUES ('Closed', 'dps', '2026-08-01', 'closed')`,
    ).run();

    runMigrations(db);

    const row = db
      .prepare('SELECT discord_user_id FROM trials WHERE character_name = ?')
      .get('Closed');
    expect(row).toEqual({ discord_user_id: null });
  });

  it('never overwrites a departed_notified_at stamp, and re-running the block is a no-op', () => {
    db.prepare(
      "INSERT INTO raiders (character_name, discord_user_id) VALUES ('Twice', 'u-raider')",
    ).run();
    db.prepare(
      `INSERT INTO trials (character_name, role, start_date) VALUES ('Twice', 'dps', '2026-08-01')`,
    ).run();

    runMigrations(db);
    db.prepare(
      "UPDATE trials SET departed_notified_at = '2026-08-11 12:00:00' WHERE character_name = 'Twice'",
    ).run();

    // Delete the version-13 stamp so the second call genuinely re-runs the v13
    // block against a database that already has the columns and back-filled
    // values, rather than skipping it on the version gate — that would only
    // prove the gate works, not that the block itself is safe to re-run.
    db.prepare('DELETE FROM schema_version WHERE version = 13').run();
    runMigrations(db);

    const row = db
      .prepare('SELECT discord_user_id, departed_notified_at FROM trials WHERE character_name = ?')
      .get('Twice');
    expect(row).toEqual({
      discord_user_id: 'u-raider',
      departed_notified_at: '2026-08-11 12:00:00',
    });
  });

  it('skips the v13 block entirely once the version gate has advanced past it', () => {
    db.prepare(
      "INSERT INTO raiders (character_name, discord_user_id) VALUES ('Gated', 'u-raider')",
    ).run();
    db.prepare(
      `INSERT INTO trials (character_name, role, start_date) VALUES ('Gated', 'dps', '2026-08-01')`,
    ).run();

    runMigrations(db);

    // A second call without deleting the version-13 row must be a true no-op:
    // no further ALTER/UPDATE work, and no error from re-running against a
    // schema that has already moved on.
    expect(() => runMigrations(db)).not.toThrow();

    const row = db
      .prepare('SELECT discord_user_id FROM trials WHERE character_name = ?')
      .get('Gated');
    expect(row).toEqual({ discord_user_id: 'u-raider' });
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createTables } from '../../src/database/schema.js';
import { runMigrations } from '../../src/database/db.js';
import { getRecentQuips, recordQuip } from '../../src/functions/raids/quipHistory.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  createTables(db);
  runMigrations(db);
});

afterEach(() => {
  db.close();
});

describe('quip history', () => {
  it('migration creates the quip_history table', () => {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'quip_history'")
      .get();
    expect(row).toBeDefined();
  });

  it('returns recent quips newest first, capped at the limit', () => {
    for (let i = 1; i <= 12; i++) recordQuip(db, `quip ${i}`);
    const recent = getRecentQuips(db, 10);
    expect(recent).toHaveLength(10);
    expect(recent[0]).toBe('quip 12');
    expect(recent[9]).toBe('quip 3');
  });

  it('returns an empty array when there is no history', () => {
    expect(getRecentQuips(db)).toEqual([]);
  });

  it('trims the table to the keep limit on insert', () => {
    for (let i = 1; i <= 55; i++) recordQuip(db, `quip ${i}`);
    const count = db.prepare('SELECT COUNT(*) AS n FROM quip_history').get() as { n: number };
    expect(count.n).toBe(50);
    // Oldest survivor is quip 6; quips 1-5 were trimmed.
    expect(getRecentQuips(db, 50).at(-1)).toBe('quip 6');
  });

  it('creates quip_history when upgrading an existing v6 database', () => {
    const oldDb = new Database(':memory:');
    try {
      oldDb.exec(`
        CREATE TABLE schema_version (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      for (let v = 1; v <= 6; v++) {
        oldDb.prepare('INSERT INTO schema_version (version) VALUES (?)').run(v);
      }

      runMigrations(oldDb);

      const table = oldDb
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'quip_history'")
        .get();
      expect(table).toBeDefined();
      const max = oldDb.prepare('SELECT MAX(version) AS v FROM schema_version').get() as {
        v: number;
      };
      expect(max.v).toBe(7);
    } finally {
      oldDb.close();
    }
  });
});

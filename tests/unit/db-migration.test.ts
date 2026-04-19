import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getDatabase, closeDatabase, runMigrations } from '../../src/database/db.js';
import { createTables } from '../../src/database/schema.js';

beforeEach(() => {
  closeDatabase();
  const db = getDatabase(':memory:');
  createTables(db);
});

afterEach(() => {
  closeDatabase();
});

describe('runMigrations — epgp_channel_id -> epgp_rankings_channel_id', () => {
  it('moves the old key value to the new key', () => {
    const db = getDatabase();
    db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run('epgp_channel_id', 'chan-123');

    runMigrations(db);

    const oldKey = db.prepare('SELECT value FROM config WHERE key = ?').get('epgp_channel_id');
    const newKey = db.prepare('SELECT value FROM config WHERE key = ?').get('epgp_rankings_channel_id') as
      | { value: string }
      | undefined;

    expect(oldKey).toBeUndefined();
    expect(newKey?.value).toBe('chan-123');
  });

  it('is idempotent when run a second time', () => {
    const db = getDatabase();
    db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run('epgp_channel_id', 'chan-123');

    runMigrations(db);
    runMigrations(db);

    const newKey = db.prepare('SELECT value FROM config WHERE key = ?').get('epgp_rankings_channel_id') as
      | { value: string }
      | undefined;
    expect(newKey?.value).toBe('chan-123');
  });

  it('does nothing when the old key is absent', () => {
    const db = getDatabase();
    db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run('epgp_rankings_channel_id', 'chan-999');

    runMigrations(db);

    const newKey = db.prepare('SELECT value FROM config WHERE key = ?').get('epgp_rankings_channel_id') as
      | { value: string }
      | undefined;
    expect(newKey?.value).toBe('chan-999');
  });

  it('logs a warning when both epgp keys are set to different values', () => {
    const db = getDatabase();
    db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run('epgp_channel_id', 'old-chan');
    db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run('epgp_rankings_channel_id', 'new-chan');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    runMigrations(db);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Both epgp_channel_id'),
    );
    warnSpy.mockRestore();
  });

  it('does not overwrite an existing new-key value if both are set', () => {
    const db = getDatabase();
    db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run('epgp_channel_id', 'old-chan');
    db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run('epgp_rankings_channel_id', 'new-chan');

    runMigrations(db);

    const newKey = db.prepare('SELECT value FROM config WHERE key = ?').get('epgp_rankings_channel_id') as
      | { value: string }
      | undefined;
    expect(newKey?.value).toBe('new-chan');

    const oldKey = db.prepare('SELECT value FROM config WHERE key = ?').get('epgp_channel_id');
    expect(oldKey).toBeUndefined();
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

    const version = db
      .prepare('SELECT MAX(version) as v FROM schema_version')
      .get() as { v: number };
    expect(version.v).toBeGreaterThanOrEqual(3);
  });

  it('is a no-op when signup_messages is already gone', () => {
    const db = getDatabase();

    expect(() => runMigrations(db)).not.toThrow();
    expect(() => runMigrations(db)).not.toThrow();
  });
});

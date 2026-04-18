import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

import { describe, it, expect, afterEach } from 'vitest';
import { getDatabase, closeDatabase } from '../../src/database/db.js';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('database', () => {
  let tempDir: string | null = null;

  afterEach(() => {
    closeDatabase();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('should return a database instance', () => {
    const db = getDatabase(':memory:');
    expect(db).toBeDefined();
    expect(db.open).toBe(true);
  });

  it('should return the same instance on subsequent calls', () => {
    const db1 = getDatabase(':memory:');
    const db2 = getDatabase(':memory:');
    expect(db1).toBe(db2);
  });

  it('should have WAL mode enabled', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'scbot-test-'));
    const dbPath = join(tempDir, 'test.sqlite');
    const db = getDatabase(dbPath);
    const result = db.pragma('journal_mode') as { journal_mode: string }[];
    expect(result[0].journal_mode).toBe('wal');
  });

  it('should have foreign keys enabled', () => {
    const db = getDatabase(':memory:');
    const result = db.pragma('foreign_keys') as { foreign_keys: number }[];
    expect(result[0].foreign_keys).toBe(1);
  });
});

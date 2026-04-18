import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createTables } from '../../src/database/schema.js';
import { seedRaiders } from '../../src/functions/testdata/seedRaiders.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  createTables(db);
});

afterEach(() => {
  db.close();
});

describe('seedRaiders', () => {
  it('inserts 15 mock raiders into the database', () => {
    seedRaiders(db);

    const rows = db.prepare('SELECT * FROM raiders').all() as Array<{
      character_name: string;
      realm: string;
      region: string;
      rank: number;
      class: string;
    }>;

    expect(rows).toHaveLength(15);
  });

  it('raiders have varied realms', () => {
    seedRaiders(db);

    const rows = db.prepare('SELECT DISTINCT realm FROM raiders').all() as Array<{ realm: string }>;
    const realms = rows.map((r) => r.realm);

    expect(realms.length).toBeGreaterThan(1);
  });

  it('raiders have varied classes', () => {
    seedRaiders(db);

    const rows = db.prepare('SELECT DISTINCT class FROM raiders').all() as Array<{ class: string }>;
    const classes = rows.map((r) => r.class);

    expect(classes.length).toBeGreaterThan(1);
  });

  it('at least one raider has a special character in their name', () => {
    seedRaiders(db);

    const rows = db.prepare('SELECT character_name FROM raiders').all() as Array<{
      character_name: string;
    }>;

    const hasSpecialChar = rows.some((r) => /[àáâãäåæçèéêëìíîïðñòóôõöùúûüýþÿ']/i.test(r.character_name));
    expect(hasSpecialChar).toBe(true);
  });

  it('is idempotent — calling twice does not duplicate raiders', () => {
    seedRaiders(db);
    seedRaiders(db);

    const rows = db.prepare('SELECT * FROM raiders').all();
    expect(rows).toHaveLength(15);
  });

  it('all raiders have valid rank, realm, and region', () => {
    seedRaiders(db);

    const rows = db.prepare('SELECT * FROM raiders').all() as Array<{
      character_name: string;
      realm: string;
      region: string;
      rank: number;
      class: string;
    }>;

    for (const row of rows) {
      expect(row.realm).toBeTruthy();
      expect(row.region).toBeTruthy();
      expect(typeof row.rank).toBe('number');
      expect(row.class).toBeTruthy();
    }
  });
});

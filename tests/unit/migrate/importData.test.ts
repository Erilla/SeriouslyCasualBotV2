import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createTables } from '../../../src/database/schema.js';
import {
  importIdentityMap,
  importOverlords,
  importIgnored,
  backfillRaiderLinks,
} from '../../../src/functions/migrate/importData.js';

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  createTables(db);
});

afterEach(() => {
  db.close();
});

describe('importIdentityMap', () => {
  it('inserts entries and is idempotent on re-run', () => {
    const entries = [
      { characterName: 'Alpha', discordUserId: '1' },
      { characterName: 'Beta', discordUserId: '2' },
    ];
    const first = importIdentityMap(db, entries);
    expect(first).toEqual({ inserted: 2, skipped: 0 });

    const rows = db
      .prepare(
        'SELECT character_name, discord_user_id FROM raider_identity_map ORDER BY character_name',
      )
      .all();
    expect(rows).toEqual([
      { character_name: 'Alpha', discord_user_id: '1' },
      { character_name: 'Beta', discord_user_id: '2' },
    ]);

    const second = importIdentityMap(db, entries);
    expect(second).toEqual({ inserted: 0, skipped: 2 });
  });
});

describe('importOverlords', () => {
  it('inserts overlords and skips duplicates by name', () => {
    const first = importOverlords(db, [{ name: 'Bing', userId: '9' }]);
    expect(first).toEqual({ inserted: 1, skipped: 0 });
    const second = importOverlords(db, [{ name: 'Bing', userId: '9' }]);
    expect(second).toEqual({ inserted: 0, skipped: 1 });
    expect(db.prepare('SELECT COUNT(*) c FROM overlords').get()).toEqual({ c: 1 });
    const row = db.prepare("SELECT name, user_id FROM overlords WHERE name = 'Bing'").get();
    expect(row).toEqual({ name: 'Bing', user_id: '9' });
  });
});

describe('importIgnored', () => {
  it('inserts ignored characters and skips duplicates', () => {
    const first = importIgnored(db, ['Ryann', 'Foo']);
    expect(first).toEqual({ inserted: 2, skipped: 0 });
    const second = importIgnored(db, ['Ryann']);
    expect(second).toEqual({ inserted: 0, skipped: 1 });
    const rows = db
      .prepare('SELECT character_name FROM ignored_characters ORDER BY character_name')
      .all();
    expect(rows).toEqual([{ character_name: 'Foo' }, { character_name: 'Ryann' }]);
  });
});

describe('backfillRaiderLinks', () => {
  it('links existing unlinked raiders by case-insensitive name, without overwriting linked ones', () => {
    // Unlinked raider (matches map, different case), already-linked raider (must not change),
    // and an unlinked raider with no map entry (must stay null).
    db.prepare(
      "INSERT INTO raiders (character_name, discord_user_id) VALUES ('eldrítch', NULL)",
    ).run();
    db.prepare("INSERT INTO raiders (character_name, discord_user_id) VALUES ('Bob', '999')").run();
    db.prepare(
      "INSERT INTO raiders (character_name, discord_user_id) VALUES ('Nomatch', NULL)",
    ).run();

    const linked = backfillRaiderLinks(db, [
      { characterName: 'Eldrítch', discordUserId: '230118286229110784' },
      { characterName: 'Bob', discordUserId: '111' }, // Bob already linked → must be ignored
    ]);
    expect(linked).toBe(1);

    const eldritch = db
      .prepare("SELECT discord_user_id FROM raiders WHERE character_name = 'eldrítch'")
      .get();
    expect(eldritch).toEqual({ discord_user_id: '230118286229110784' });
    const bob = db
      .prepare("SELECT discord_user_id FROM raiders WHERE character_name = 'Bob'")
      .get();
    expect(bob).toEqual({ discord_user_id: '999' });
    const nomatch = db
      .prepare("SELECT discord_user_id FROM raiders WHERE character_name = 'Nomatch'")
      .get();
    expect(nomatch).toEqual({ discord_user_id: null });
  });
});

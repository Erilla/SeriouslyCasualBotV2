import type Database from 'better-sqlite3';
import type { V1IdentityEntry, V1Overlord } from './parseV1Export.js';

export interface ImportCount {
  inserted: number;
  skipped: number;
}

export function importIdentityMap(db: Database.Database, entries: V1IdentityEntry[]): ImportCount {
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO raider_identity_map (character_name, discord_user_id) VALUES (?, ?)',
  );
  let inserted = 0;
  for (const e of entries) {
    inserted += stmt.run(e.characterName, e.discordUserId).changes;
  }
  return { inserted, skipped: entries.length - inserted };
}

export function importOverlords(db: Database.Database, overlords: V1Overlord[]): ImportCount {
  const stmt = db.prepare('INSERT OR IGNORE INTO overlords (name, user_id) VALUES (?, ?)');
  let inserted = 0;
  for (const o of overlords) {
    inserted += stmt.run(o.name, o.userId).changes;
  }
  return { inserted, skipped: overlords.length - inserted };
}

export function importIgnored(db: Database.Database, names: string[]): ImportCount {
  const stmt = db.prepare('INSERT OR IGNORE INTO ignored_characters (character_name) VALUES (?)');
  let inserted = 0;
  for (const n of names) {
    inserted += stmt.run(n).changes;
  }
  return { inserted, skipped: names.length - inserted };
}

export function backfillRaiderLinks(db: Database.Database, entries: V1IdentityEntry[]): number {
  // Only touch raiders that currently have no linked user; match by name
  // case-insensitively to mirror syncRaiders' lookup.
  const stmt = db.prepare(
    'UPDATE raiders SET discord_user_id = ? WHERE discord_user_id IS NULL AND lower(character_name) = lower(?)',
  );
  let linked = 0;
  for (const e of entries) {
    linked += stmt.run(e.discordUserId, e.characterName).changes;
  }
  return linked;
}

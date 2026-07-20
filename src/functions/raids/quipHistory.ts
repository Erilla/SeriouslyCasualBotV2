import type Database from 'better-sqlite3';

/** Newest-first list of recent quips for the anti-repetition prompt block. */
export function getRecentQuips(db: Database.Database, limit = 10): string[] {
  const rows = db
    .prepare('SELECT quip FROM quip_history ORDER BY id DESC LIMIT ?')
    .all(limit) as { quip: string }[];
  return rows.map((r) => r.quip);
}

/**
 * Record a generated quip and trim the table to the newest `keep` rows.
 * Only LLM-generated quips should be recorded — the static fallback corpus
 * is meant to repeat.
 */
export function recordQuip(db: Database.Database, quip: string, keep = 50): void {
  db.prepare('INSERT INTO quip_history (quip) VALUES (?)').run(quip);
  db.prepare(
    'DELETE FROM quip_history WHERE id NOT IN (SELECT id FROM quip_history ORDER BY id DESC LIMIT ?)',
  ).run(keep);
}

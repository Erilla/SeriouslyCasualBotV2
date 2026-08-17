import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../src/database/db.js';
import type { RaiderRow } from '../../src/types/index.js';

vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { ensureRaiderForTrial } from '../../src/functions/raids/ensureTrialRaiders.js';

/**
 * Pins the contract of the single non-sync writer of trial roster rows:
 * `createTrialReviewThread`, which both trial-creation paths (an accepted
 * application and `/trials create`) go through. Driving the whole function needs
 * a forum-channel Discord mock this repo has no harness for, so this test pins
 * the call it makes rather than the call site.
 */
describe('creating a trial makes the character a roster member', () => {
  beforeEach(() => {
    closeDatabase();
    initDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
  });

  it('inserts a linked row using the resolved trial Discord id and the intel realm', () => {
    const db = getDatabase();
    db.prepare(
      `INSERT INTO applicant_intel_jobs (application_id, character_name, character_realm, character_region)
       VALUES (?, 'Etav', 'draenor', 'eu')`,
    ).run(42);

    // Exactly the object createTrialReviewThread passes after its trials insert.
    const result = ensureRaiderForTrial(db, {
      character_name: 'Etav',
      discord_user_id: '178221862721945611',
      application_id: 42,
    });

    expect(result).toBe('inserted');
    const row = db
      .prepare('SELECT * FROM raiders WHERE character_name = ?')
      .get('Etav') as RaiderRow;
    expect(row.discord_user_id).toBe('178221862721945611');
    expect(row.realm).toBe('draenor');
  });

  it('inserts a row for a `/trials create` trial, which has no application', () => {
    const db = getDatabase();

    // The command path: no application_id, so no intel job to read a realm from.
    const result = ensureRaiderForTrial(db, {
      character_name: 'Neralia',
      discord_user_id: '999888777',
      application_id: null,
    });

    expect(result).toBe('inserted');
    const row = db
      .prepare('SELECT * FROM raiders WHERE character_name = ?')
      .get('Neralia') as RaiderRow;
    expect(row.discord_user_id).toBe('999888777');
    expect(row.realm).toBe('silvermoon');
  });
});

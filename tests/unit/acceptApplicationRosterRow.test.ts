import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../src/database/db.js';
import type { RaiderRow } from '../../src/types/index.js';

vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { ensureRaiderForTrial } from '../../src/functions/raids/ensureTrialRaiders.js';

describe('accepting an application makes the applicant a roster member', () => {
  beforeEach(() => {
    closeDatabase();
    initDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
  });

  it('inserts a linked row using the applicant Discord id and the intel realm', () => {
    const db = getDatabase();
    db.prepare(
      `INSERT INTO applicant_intel_jobs (application_id, character_name, character_realm, character_region)
       VALUES (?, 'Etav', 'draenor', 'eu')`,
    ).run(42);

    // Exactly the object acceptApplication passes after createTrialReviewThread.
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
});

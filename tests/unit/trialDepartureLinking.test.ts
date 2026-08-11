import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { closeDatabase, getDatabase } from '../../src/database/db.js';
import { createTables } from '../../src/database/schema.js';
import { resolveTrialDiscordUserId } from '../../src/functions/trial-review/createTrialReviewThread.js';

describe('resolveTrialDiscordUserId', () => {
  beforeEach(() => createTables(getDatabase(':memory:')));
  afterEach(() => closeDatabase());

  it('prefers the id the officer picked', () => {
    getDatabase()
      .prepare(
        "INSERT INTO raiders (character_name, discord_user_id) VALUES ('Brentpriest', 'u-raider')",
      )
      .run();

    expect(resolveTrialDiscordUserId('Brentpriest', 'u-picked')).toBe('u-picked');
  });

  it('falls back to the raiders row when the officer picked nobody', () => {
    getDatabase()
      .prepare(
        "INSERT INTO raiders (character_name, discord_user_id) VALUES ('Brentpriest', 'u-raider')",
      )
      .run();

    expect(resolveTrialDiscordUserId('Brentpriest', undefined)).toBe('u-raider');
  });

  it('returns null when the character is not a known raider — the common case for a new trial', () => {
    expect(resolveTrialDiscordUserId('Stranger', undefined)).toBeNull();
  });

  it('ignores a raiders row that has no linked Discord account', () => {
    getDatabase()
      .prepare("INSERT INTO raiders (character_name, discord_user_id) VALUES ('Unlinked', NULL)")
      .run();

    expect(resolveTrialDiscordUserId('Unlinked', undefined)).toBeNull();
  });
});

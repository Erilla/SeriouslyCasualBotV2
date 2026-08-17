import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../src/database/db.js';

vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { resolveSignupMentions } from '../../src/functions/raids/resolveSignupMentions.js';

function addRaider(
  name: string,
  discordUserId: string | null,
  inactiveSince: string | null = null,
) {
  getDatabase()
    .prepare(
      'INSERT INTO raiders (character_name, discord_user_id, inactive_since) VALUES (?, ?, ?)',
    )
    .run(name, discordUserId, inactiveSince);
}

function addTrial(name: string, discordUserId: string | null, status = 'active') {
  getDatabase()
    .prepare(
      `INSERT INTO trials (character_name, role, start_date, status, discord_user_id)
       VALUES (?, 'DPS', '2026-08-18', ?, ?)`,
    )
    .run(name, status, discordUserId);
}

function addIdentity(name: string, discordUserId: string) {
  getDatabase()
    .prepare('INSERT INTO raider_identity_map (character_name, discord_user_id) VALUES (?, ?)')
    .run(name, discordUserId);
}

/**
 * The vetting the map entry needs to be trusted: the applicant's own application,
 * naming this character, resolved by an officer with the given status.
 */
function addApplication(name: string, discordUserId: string, status: string) {
  getDatabase()
    .prepare(
      'INSERT INTO applications (character_name, applicant_user_id, status) VALUES (?, ?, ?)',
    )
    .run(name, discordUserId, status);
}

describe('resolveSignupMentions', () => {
  beforeEach(() => {
    closeDatabase();
    initDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
  });

  it('mentions a linked active raider', () => {
    addRaider('Jovaz', '111');

    expect(resolveSignupMentions(getDatabase(), ['Jovaz'])).toEqual(['<@111>']);
  });

  it('matches raiders case-insensitively', () => {
    addRaider('Jovaz', '111');

    expect(resolveSignupMentions(getDatabase(), ['jovaz'])).toEqual(['<@111>']);
  });

  it('mentions an active trial with no raiders row yet', () => {
    // The bug: a brand-new trial signs up in wowaudit before Raider.IO's roster
    // reports them, so `raiders` has nothing to mention them by.
    addTrial('Neralia', '222');

    expect(resolveSignupMentions(getDatabase(), ['neralia'])).toEqual(['<@222>']);
  });

  it('mentions a trial whose raiders row exists but is unlinked', () => {
    addRaider('Neralia', null);
    addTrial('Neralia', '222');

    expect(resolveSignupMentions(getDatabase(), ['Neralia'])).toEqual(['<@222>']);
  });

  it('falls back to the application identity map', () => {
    addIdentity('Etav', '333');
    addApplication('Etav', '333', 'accepted');

    expect(resolveSignupMentions(getDatabase(), ['etav'])).toEqual(['<@333>']);
  });

  it('vets the identity map against an accepted application, case-insensitively', () => {
    addIdentity('Etav', '333');
    addApplication('etav', '333', 'accepted');

    expect(resolveSignupMentions(getDatabase(), ['Etav'])).toEqual(['<@333>']);
  });

  it('ignores an identity map entry with no accepted application', () => {
    // Written at submission from a name the applicant typed. Trusting it before
    // an officer decides would let anyone be pinged in a raider's place.
    addIdentity('Etav', '333');
    addApplication('Etav', '333', 'submitted');

    expect(resolveSignupMentions(getDatabase(), ['Etav'])).toEqual(['**Etav**']);
  });

  it('ignores an identity map entry whose application was rejected', () => {
    addIdentity('Etav', '333');
    addApplication('Etav', '333', 'rejected');

    expect(resolveSignupMentions(getDatabase(), ['Etav'])).toEqual(['**Etav**']);
  });

  it('ignores an identity map entry with no application at all', () => {
    addIdentity('Etav', '333');

    expect(resolveSignupMentions(getDatabase(), ['Etav'])).toEqual(['**Etav**']);
  });

  it('ignores an identity map entry vetted by a different application', () => {
    // Jovaz was accepted for Jovaz; that must not vouch for a map row claiming
    // Etav belongs to a different Discord user.
    addIdentity('Etav', '333');
    addApplication('Jovaz', '333', 'accepted');
    addApplication('Etav', '444', 'accepted');

    expect(resolveSignupMentions(getDatabase(), ['Etav'])).toEqual(['**Etav**']);
  });

  it('prefers the raiders link over trials and the identity map', () => {
    addRaider('Etav', '111');
    addTrial('Etav', '222');
    addIdentity('Etav', '333');
    addApplication('Etav', '333', 'accepted');

    expect(resolveSignupMentions(getDatabase(), ['Etav'])).toEqual(['<@111>']);
  });

  it('prefers an active trial over the identity map', () => {
    addTrial('Etav', '222');
    addIdentity('Etav', '333');
    addApplication('Etav', '333', 'accepted');

    expect(resolveSignupMentions(getDatabase(), ['Etav'])).toEqual(['<@222>']);
  });

  it('ignores a closed trial', () => {
    addTrial('Etav', '222', 'closed');

    expect(resolveSignupMentions(getDatabase(), ['Etav'])).toEqual(['**Etav**']);
  });

  it('ignores an inactive raider row but still uses their identity map link', () => {
    addRaider('Etav', '111', '2026-01-01T00:00:00Z');
    addIdentity('Etav', '333');
    addApplication('Etav', '333', 'accepted');

    expect(resolveSignupMentions(getDatabase(), ['Etav'])).toEqual(['<@333>']);
  });

  it('falls back to the bold character name when nothing knows the character', () => {
    expect(resolveSignupMentions(getDatabase(), ['Etav'])).toEqual(['**Etav**']);
  });

  it('preserves the order and the given spelling of each name', () => {
    addRaider('Jovaz', '111');

    expect(resolveSignupMentions(getDatabase(), ['Etav', 'Jovaz', 'Neralia'])).toEqual([
      '**Etav**',
      '<@111>',
      '**Neralia**',
    ]);
  });
});

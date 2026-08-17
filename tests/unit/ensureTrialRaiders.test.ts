import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../src/database/db.js';
import type { RaiderRow } from '../../src/types/index.js';

vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  ensureRaiderForTrial,
  ensureRaidersForActiveTrials,
  trialRealm,
  DEFAULT_REALM,
  DEFAULT_REGION,
} from '../../src/functions/raids/ensureTrialRaiders.js';

function addTrial(
  name: string,
  discordUserId: string | null,
  status = 'active',
  applicationId: number | null = null,
) {
  getDatabase()
    .prepare(
      `INSERT INTO trials (character_name, role, start_date, status, discord_user_id, application_id)
       VALUES (?, 'DPS', '2026-08-18', ?, ?, ?)`,
    )
    .run(name, status, discordUserId, applicationId);
}

function addRaider(name: string, discordUserId: string | null) {
  getDatabase()
    .prepare('INSERT INTO raiders (character_name, discord_user_id) VALUES (?, ?)')
    .run(name, discordUserId);
}

function addIntelJob(applicationId: number, realm: string, region: string) {
  getDatabase()
    .prepare(
      `INSERT INTO applicant_intel_jobs (application_id, character_name, character_realm, character_region)
       VALUES (?, 'Whoever', ?, ?)`,
    )
    .run(applicationId, realm, region);
}

function raider(name: string): RaiderRow | undefined {
  return getDatabase()
    .prepare('SELECT * FROM raiders WHERE character_name = ? COLLATE NOCASE')
    .get(name) as RaiderRow | undefined;
}

const trialOf = (
  name: string,
  discordUserId: string | null,
  applicationId: number | null = null,
) => ({
  character_name: name,
  discord_user_id: discordUserId,
  application_id: applicationId,
});

describe('ensureRaiderForTrial', () => {
  beforeEach(() => {
    closeDatabase();
    initDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
  });

  it('inserts a linked row for a trial with no raiders row', () => {
    expect(ensureRaiderForTrial(getDatabase(), trialOf('Neralia', '222'))).toBe('inserted');

    const row = raider('Neralia');
    expect(row?.discord_user_id).toBe('222');
    expect(row?.realm).toBe(DEFAULT_REALM);
    expect(row?.region).toBe(DEFAULT_REGION);
    expect(row?.rank).toBeNull();
    expect(row?.class).toBeNull();
  });

  it('is idempotent: a second call reports exists and does not duplicate', () => {
    ensureRaiderForTrial(getDatabase(), trialOf('Neralia', '222'));

    expect(ensureRaiderForTrial(getDatabase(), trialOf('Neralia', '222'))).toBe('exists');
    const count = getDatabase()
      .prepare('SELECT COUNT(*) AS n FROM raiders WHERE character_name = ? COLLATE NOCASE')
      .get('Neralia') as { n: number };
    expect(count.n).toBe(1);
  });

  it('matches an existing row case-insensitively', () => {
    addRaider('Neralia', '222');

    expect(ensureRaiderForTrial(getDatabase(), trialOf('neralia', '222'))).toBe('exists');
  });

  it('fills a null discord_user_id from the trial', () => {
    addRaider('Neralia', null);

    expect(ensureRaiderForTrial(getDatabase(), trialOf('Neralia', '222'))).toBe('linked');
    expect(raider('Neralia')?.discord_user_id).toBe('222');
  });

  it('never overwrites an existing discord_user_id', () => {
    addRaider('Neralia', '111');

    expect(ensureRaiderForTrial(getDatabase(), trialOf('Neralia', '222'))).toBe('exists');
    expect(raider('Neralia')?.discord_user_id).toBe('111');
  });

  it('leaves an unlinked row unlinked when the trial has no Discord user either', () => {
    addRaider('Neralia', null);

    expect(ensureRaiderForTrial(getDatabase(), trialOf('Neralia', null))).toBe('exists');
    expect(raider('Neralia')?.discord_user_id).toBeNull();
  });

  it('refuses to insert an ignored character', () => {
    getDatabase()
      .prepare('INSERT INTO ignored_characters (character_name) VALUES (?)')
      .run('Neralia');

    expect(ensureRaiderForTrial(getDatabase(), trialOf('neralia', '222'))).toBe('ignored');
    expect(raider('Neralia')).toBeUndefined();
  });

  it('takes realm and region from the applicant intel job when there is one', () => {
    addIntelJob(7, 'draenor', 'eu');

    ensureRaiderForTrial(getDatabase(), trialOf('Jovaz', '111', 7));

    expect(raider('Jovaz')?.realm).toBe('draenor');
    expect(raider('Jovaz')?.region).toBe('eu');
  });
});

describe('trialRealm', () => {
  beforeEach(() => {
    closeDatabase();
    initDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
  });

  it('defaults when the trial has no application', () => {
    expect(trialRealm(getDatabase(), { application_id: null })).toEqual({
      realm: DEFAULT_REALM,
      region: DEFAULT_REGION,
    });
  });

  it('defaults when the application ran no intel job', () => {
    expect(trialRealm(getDatabase(), { application_id: 7 })).toEqual({
      realm: DEFAULT_REALM,
      region: DEFAULT_REGION,
    });
  });

  it('uses the newest intel job for the application', () => {
    addIntelJob(7, 'silvermoon', 'eu');
    addIntelJob(7, 'draenor', 'eu');

    expect(trialRealm(getDatabase(), { application_id: 7 })).toEqual({
      realm: 'draenor',
      region: 'eu',
    });
  });
});

describe('ensureRaidersForActiveTrials', () => {
  beforeEach(() => {
    closeDatabase();
    initDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
  });

  it('inserts rows for active trials only', () => {
    addTrial('Etav', '333');
    addTrial('Oldtrial', '444', 'closed');
    addTrial('Promoted', '555', 'promoted');

    ensureRaidersForActiveTrials(getDatabase());

    expect(raider('Etav')).toBeDefined();
    expect(raider('Oldtrial')).toBeUndefined();
    expect(raider('Promoted')).toBeUndefined();
  });

  it('returns freshly inserted rows that have no Discord link', () => {
    addTrial('Unlinked', null);
    addTrial('Linked', '333');

    const inserted = ensureRaidersForActiveTrials(getDatabase());

    expect(inserted.map((r) => r.character_name)).toEqual(['Unlinked']);
    expect(inserted[0].id).toBeGreaterThan(0);
  });

  it('returns nothing on a second run, so the sync cannot re-alert', () => {
    addTrial('Unlinked', null);
    ensureRaidersForActiveTrials(getDatabase());

    expect(ensureRaidersForActiveTrials(getDatabase())).toEqual([]);
  });

  it('tolerates two active trials for the same character', () => {
    addTrial('Etav', '333');
    addTrial('Etav', '333');

    expect(() => ensureRaidersForActiveTrials(getDatabase())).not.toThrow();
    const count = getDatabase().prepare('SELECT COUNT(*) AS n FROM raiders').get() as { n: number };
    expect(count.n).toBe(1);
  });
});

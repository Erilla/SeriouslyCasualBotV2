import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { closeDatabase, getDatabase } from '../../src/database/db.js';
import { createTables } from '../../src/database/schema.js';

vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createJob, getFindings } from '../../src/functions/applications/intel/jobStore.js';
import {
  discoverAlts,
  type DiscoverDeps,
} from '../../src/functions/applications/alts/discoverAlts.js';

const applicant = { region: 'eu', realm: 'draenor', name: 'Brentpriest' };

/** Two same-account characters share timestamps; the third does not. */
const fingerprints: Record<string, Map<number, number>> = {
  brentpriest: new Map(Array.from({ length: 400 }, (_, i) => [i, 1000 + i])),
  brenthunter: new Map(Array.from({ length: 400 }, (_, i) => [i, 1000 + i])),
  stranger: new Map(Array.from({ length: 400 }, (_, i) => [i, 5000 + i])),
};

function deps(over: Partial<DiscoverDeps> = {}): DiscoverDeps {
  return {
    getCharacterOwner: vi.fn(async () => null),
    getClaimedCharacters: vi.fn(async () => []),
    getCharacterSummary: vi.fn(async () => ({ className: 'Priest', guild: null })),
    getCharacterGuild: vi.fn(async () => null),
    getGuildRoster: vi.fn(async () => []),
    getCharacterFingerprint: vi.fn(async (c) => fingerprints[c.name.toLowerCase()] ?? null),
    getMythicKillDates: vi.fn(async () => []),
    tierOrdinals: [35],
    paceMs: 0,
    ...over,
  };
}

describe('discoverAlts', () => {
  let jobId: number;
  beforeEach(() => {
    createTables(getDatabase(':memory:'));
    jobId = createJob({ applicationId: 1, targetChannelId: '1', character: applicant });
  });
  afterEach(() => closeDatabase());

  it('records the application character itself', async () => {
    await discoverAlts(jobId, [applicant], deps());
    const found = getFindings(jobId);
    expect(found).toHaveLength(1);
    expect(found[0].source).toBe('application');
  });

  it('records claimed characters from the owner lookup at full confidence', async () => {
    await discoverAlts(
      jobId,
      [applicant],
      deps({
        getCharacterOwner: vi.fn(async () => ({
          user: 'Brentoan',
          discordProfile: 'brent',
          declaredMain: null,
        })),
        getClaimedCharacters: vi.fn(async () => [
          { name: 'Brenthunter', realm: 'Draenor', className: 'Hunter', level: 90 },
        ]),
      }),
    );
    const hunter = getFindings(jobId).find((f) => f.name === 'Brenthunter')!;
    expect(hunter.source).toBe('raider.io');
    expect(hunter.confidence).toBe(100);
  });

  it('records a declared main', async () => {
    await discoverAlts(
      jobId,
      [applicant],
      deps({
        getCharacterOwner: vi.fn(async () => ({
          user: null,
          discordProfile: null,
          declaredMain: { region: 'eu', realm: 'draenor', name: 'Brenthunter' },
        })),
      }),
    );
    expect(getFindings(jobId).find((f) => f.name === 'Brenthunter')?.source).toBe('declared main');
  });

  it('fingerprints a guild roster and records only matches', async () => {
    await discoverAlts(
      jobId,
      [applicant],
      deps({
        getCharacterGuild: vi.fn(async () => ({ name: 'Rancour', realm: 'Draenor' })),
        getGuildRoster: vi.fn(async () => [
          { name: 'Brenthunter', realm: 'Draenor' },
          { name: 'Stranger', realm: 'Draenor' },
        ]),
      }),
    );
    const names = getFindings(jobId).map((f) => f.name);
    expect(names).toContain('Brenthunter');
    expect(names).not.toContain('Stranger');
  });

  it('seeds the BFS from former guilds named in the kill history', async () => {
    const getGuildRoster = vi.fn(async () => []);
    await discoverAlts(
      jobId,
      [applicant],
      deps({
        getCharacterGuild: vi.fn(async () => null),
        getGuildRoster,
        getMythicKillDates: vi.fn(async () => [
          {
            bossName: 'imperator-averzian',
            firstDefeated: '2024-12-05T00:00:00.000Z',
            guild: { name: 'SeriouslyCasual', realm: 'silvermoon' },
          },
        ]),
      }),
    );
    expect(getGuildRoster).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'SeriouslyCasual', realm: 'silvermoon' }),
    );
  });

  it("seeds the BFS from a guild's own realm, not the character's", async () => {
    const getGuildRoster = vi.fn(async () => []);
    await discoverAlts(
      jobId,
      [{ region: 'eu', realm: 'argent-dawn', name: 'Driptinus' }],
      deps({
        getCharacterGuild: vi.fn(async () => ({ name: 'Rancour', realm: 'Draenor' })),
        getGuildRoster,
      }),
    );
    expect(getGuildRoster).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Rancour', realm: 'Draenor' }),
    );
  });

  it('never fingerprints the same character twice across overlapping rosters', async () => {
    const getCharacterFingerprint = vi.fn(
      async (c: { name: string }) => fingerprints[c.name.toLowerCase()] ?? null,
    );
    await discoverAlts(
      jobId,
      [applicant],
      deps({
        getCharacterGuild: vi.fn(async () => ({ name: 'Rancour', realm: 'Draenor' })),
        getGuildRoster: vi.fn(async () => [
          { name: 'Stranger', realm: 'Draenor' },
          { name: 'Stranger', realm: 'Draenor' },
        ]),
        getCharacterFingerprint,
      }),
    );
    const strangerCalls = getCharacterFingerprint.mock.calls.filter(([c]) => c.name === 'Stranger');
    expect(strangerCalls).toHaveLength(1);
  });

  it('reports truncation when the character cap is hit', async () => {
    const roster = Array.from({ length: 20 }, (_, i) => ({ name: `Filler${i}`, realm: 'Draenor' }));
    const result = await discoverAlts(
      jobId,
      [applicant],
      deps({
        getCharacterGuild: vi.fn(async () => ({ name: 'Rancour', realm: 'Draenor' })),
        getGuildRoster: vi.fn(async () => roster),
        getCharacterFingerprint: vi.fn(async () => null),
        maxCharacters: 5,
      }),
    );
    expect(result.truncated).toBe(true);
  });

  it('treats an unavailable fingerprint as unknown, not as a non-match', async () => {
    await discoverAlts(
      jobId,
      [applicant],
      deps({
        getCharacterGuild: vi.fn(async () => ({ name: 'Rancour', realm: 'Draenor' })),
        getGuildRoster: vi.fn(async () => [{ name: 'Brenthunter', realm: 'Draenor' }]),
        getCharacterFingerprint: vi.fn(async () => null),
      }),
    );
    expect(getFindings(jobId).map((f) => f.name)).not.toContain('Brenthunter');
  });

  it('normalises realm casing so one character produces one finding, not two', async () => {
    // Claimed characters come from ch.realm.name — a display name like "Draenor"
    // — while the fingerprint roster comes from a slug like "draenor". Without
    // normalisation these land as two separate primary-key rows.
    await discoverAlts(
      jobId,
      [applicant],
      deps({
        getCharacterOwner: vi.fn(async () => ({
          user: 'Brentoan',
          discordProfile: 'brent',
          declaredMain: null,
        })),
        getClaimedCharacters: vi.fn(async () => [
          { name: 'Brenthunter', realm: 'Draenor', className: 'Hunter', level: 90 },
        ]),
        getCharacterGuild: vi.fn(async () => ({ name: 'Rancour', realm: 'Draenor' })),
        getGuildRoster: vi.fn(async () => [{ name: 'Brenthunter', realm: 'draenor' }]),
      }),
    );
    const matches = getFindings(jobId).filter((f) => f.name === 'Brenthunter');
    expect(matches).toHaveLength(1);
    expect(matches[0].source).toBe('raider.io');
  });
});

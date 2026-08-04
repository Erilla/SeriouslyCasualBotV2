import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { closeDatabase, getDatabase } from '../../src/database/db.js';
import { createTables } from '../../src/database/schema.js';

vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  createJob,
  getFindings,
  isScanned,
  scannedCount,
} from '../../src/functions/applications/intel/jobStore.js';
import {
  discoverAlts,
  type DiscoverDeps,
} from '../../src/functions/applications/alts/discoverAlts.js';
import { HttpError } from '../../src/services/httpClient.js';

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

  it('reports truncated when the applicant fingerprint itself is unavailable, even with nothing left to walk', async () => {
    // No guild, no roster, nothing left in the frontier — the only reason
    // truncation could be reported is the missing applicant baseline itself.
    const result = await discoverAlts(
      jobId,
      [applicant],
      deps({
        getCharacterFingerprint: vi.fn(async () => null),
      }),
    );
    expect(result.truncated).toBe(true);
  });

  it('marks nothing scanned for roster members when the applicant fingerprint is unavailable', async () => {
    await discoverAlts(
      jobId,
      [applicant],
      deps({
        getCharacterGuild: vi.fn(async () => ({ name: 'Rancour', realm: 'Draenor' })),
        getGuildRoster: vi.fn(async () => [{ name: 'Brenthunter', realm: 'Draenor' }]),
        getCharacterFingerprint: vi.fn(async () => null),
      }),
    );
    // Only the applicant's own character (recorded via source 0) is scanned;
    // Brenthunter, walked but never compared, must remain eligible for a later
    // run once the applicant's fingerprint becomes available.
    expect(scannedCount(jobId)).toBe(1);
    expect(isScanned(jobId, 'brenthunter-draenor')).toBe(false);
  });

  it('propagates a 429 from a member fingerprint fetch rather than swallowing it as unknown', async () => {
    const getCharacterFingerprint = vi.fn(async (c: { name: string }) => {
      if (c.name.toLowerCase() === 'brentpriest') return fingerprints.brentpriest;
      throw new HttpError({
        service: 'raiderio',
        status: 429,
        attempts: 1,
        message: 'rate limited',
      });
    });
    await expect(
      discoverAlts(
        jobId,
        [applicant],
        deps({
          getCharacterGuild: vi.fn(async () => ({ name: 'Rancour', realm: 'Draenor' })),
          getGuildRoster: vi.fn(async () => [{ name: 'Brenthunter', realm: 'Draenor' }]),
          getCharacterFingerprint,
        }),
      ),
    ).rejects.toThrow(HttpError);
  });

  it('leaves a rate-limited member unmarked scanned so a resume retries it', async () => {
    const getCharacterFingerprint = vi.fn(async (c: { name: string }) => {
      if (c.name.toLowerCase() === 'brentpriest') return fingerprints.brentpriest;
      throw new HttpError({
        service: 'raiderio',
        status: 429,
        attempts: 1,
        message: 'rate limited',
      });
    });
    await expect(
      discoverAlts(
        jobId,
        [applicant],
        deps({
          getCharacterGuild: vi.fn(async () => ({ name: 'Rancour', realm: 'Draenor' })),
          getGuildRoster: vi.fn(async () => [{ name: 'Brenthunter', realm: 'Draenor' }]),
          getCharacterFingerprint,
        }),
      ),
    ).rejects.toThrow();
    expect(isScanned(jobId, 'brenthunter-draenor')).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // RE-REVIEW ITEM 1: getCharacterSummary now rethrows a 429 (it seeds the guild
  // frontier). record() called it BEFORE addFinding, so in the post-match loop a
  // matched alt was dropped entirely while markScanned had already run for the
  // whole batch — permanently excluding it from this job and republishing a
  // SMALLER list on resume, with truncated still false because the throw
  // bypasses the return. Pre-M5 the 429 was swallowed and the finding was kept,
  // so this specific path had got worse.
  // ---------------------------------------------------------------------------
  it('still records a matched alt when the enrichment lookup is rate limited', async () => {
    const getCharacterSummary = vi.fn(async (c: { name: string }) => {
      // The applicant's own record() (source 0) succeeds; the matched alt's
      // enrichment hits the rate limit.
      if (c.name.toLowerCase() === 'brentpriest') return { className: 'Priest', guild: null };
      throw new HttpError({
        service: 'raiderio',
        status: 429,
        attempts: 1,
        message: 'rate limited',
        retryAfterMs: 60_000,
      });
    });

    await expect(
      discoverAlts(
        jobId,
        [applicant],
        deps({
          getCharacterSummary,
          getCharacterGuild: vi.fn(async () => ({ name: 'Rancour', realm: 'Draenor' })),
          getGuildRoster: vi.fn(async () => [{ name: 'Brenthunter', realm: 'Draenor' }]),
        }),
      ),
      // Still propagates, so the runner pauses and resumes the REST of the sweep.
    ).rejects.toThrow(HttpError);

    // ...but the discovered alt is on disk, because isScanned now excludes it
    // from every future run of this job.
    const found = getFindings(jobId).filter((f) => f.name === 'Brenthunter');
    expect(found).toHaveLength(1);
    expect(found[0].source).toBe('fingerprint');
    // Recorded with what was known; the enrichment is simply absent.
    expect(found[0].className).toBeNull();
    expect(found[0].guildName).toBeNull();
    // Confirms the hazard this guards: the member IS marked scanned, so a lost
    // finding here would have been unrecoverable.
    expect(isScanned(jobId, 'brenthunter-draenor')).toBe(true);
  });

  it('still records an applicant character when its own enrichment is rate limited', async () => {
    const getCharacterSummary = vi.fn(async () => {
      throw new HttpError({
        service: 'raiderio',
        status: 429,
        attempts: 1,
        message: 'rate limited',
        retryAfterMs: 60_000,
      });
    });
    await expect(discoverAlts(jobId, [applicant], deps({ getCharacterSummary }))).rejects.toThrow(
      HttpError,
    );
    expect(getFindings(jobId).map((f) => f.name)).toEqual(['Brentpriest']);
  });
});

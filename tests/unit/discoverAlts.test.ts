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
import { PhaseTimings } from '../../src/functions/applications/intel/phaseTimings.js';

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
    getAnchorFingerprint: vi.fn(async (c) => fingerprints[c.name.toLowerCase()] ?? null),
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
    await discoverAlts(jobId, applicant, [applicant], [], deps());
    const found = getFindings(jobId);
    expect(found).toHaveLength(1);
    expect(found[0].source).toBe('application');
  });

  it('records linked seeds as linked and expands their guilds', async () => {
    const linked = { region: 'eu', realm: 'silvermoon', name: 'Linkedmage' };
    const getGuildRoster = vi.fn(async () => []);

    await discoverAlts(
      jobId,
      applicant,
      [applicant],
      [linked],
      deps({
        getCharacterSummary: vi.fn(async (character) => ({
          className: character.name === linked.name ? 'Mage' : 'Priest',
          guild:
            character.name === linked.name ? { name: 'Linked Guild', realm: 'Silvermoon' } : null,
        })),
        getGuildRoster,
      }),
    );

    expect(getFindings(jobId)).toContainEqual(
      expect.objectContaining({ name: linked.name, realm: linked.realm, source: 'linked' }),
    );
    expect(getGuildRoster).toHaveBeenCalledWith({ name: 'Linked Guild', realm: 'Silvermoon' });
  });

  it('records claimed characters from the owner lookup at full confidence', async () => {
    await discoverAlts(
      jobId,
      applicant,
      [applicant],
      [],
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
      applicant,
      [applicant],
      [],
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
      applicant,
      [applicant],
      [],
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
      applicant,
      [applicant],
      [],
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

  /**
   * The claimed-character enrichment (one getCharacterSummary each, ~20 of them)
   * was 41.2s of a 119.2s job — the largest phase in it — purely because it was
   * serial. The fetches now overlap; the durable writes must not move.
   */
  describe('claimed characters, enriched concurrently', () => {
    const claimedList = (names: string[]) =>
      names.map((name) => ({ name, realm: 'Draenor', className: 'Mage', level: 80 }));
    const owner = vi.fn(async () => ({
      user: 'brent',
      discordProfile: null,
      declaredMain: null,
    }));

    it('overlaps the lookups and records every character', async () => {
      const names = ['Altone', 'Alttwo', 'Altthree', 'Altfour', 'Altfive', 'Altsix', 'Altseven'];
      let live = 0;
      let peak = 0;
      await discoverAlts(
        jobId,
        applicant,
        [applicant],
        [],
        deps({
          getCharacterOwner: owner,
          getClaimedCharacters: vi.fn(async () => claimedList(names)),
          getCharacterSummary: vi.fn(async () => {
            live++;
            peak = Math.max(peak, live);
            await new Promise((r) => setTimeout(r, 5));
            live--;
            return { className: 'Mage', guild: null };
          }),
        }),
      );

      expect(peak).toBeGreaterThan(1);
      const found = getFindings(jobId).map((f) => f.name);
      for (const n of names) expect(found).toContain(n);
    });

    /**
     * A claimed list naming the same character twice used to be caught by
     * `known.has` inside the loop. Concurrent fetches cannot see each other's
     * characters, so the dedupe has to happen before the batch.
     */
    it('fetches a duplicated claimed character only once', async () => {
      const getCharacterSummary = vi.fn(async () => ({ className: 'Mage', guild: null }));
      await discoverAlts(
        jobId,
        applicant,
        [applicant],
        [],
        deps({
          getCharacterOwner: owner,
          getClaimedCharacters: vi.fn(async () => claimedList(['Altone', 'Altone', 'Alttwo'])),
          getCharacterSummary,
        }),
      );
      const looked = getCharacterSummary.mock.calls.map(
        (call) => (call as unknown as [{ name: string }])[0].name,
      );
      expect(looked.filter((n) => n === 'Altone')).toHaveLength(1);
    });

    /**
     * The serial version stopped at the first rate limit: that character's
     * finding was written unenriched, and the ones after it were left for the
     * resumed run. Committing them anyway would make their missing class and
     * guild PERMANENT, because addFinding's SOURCE_RANK guard drops a second
     * write of the same source.
     */
    it('commits up to the first failure and no further, then pauses', async () => {
      const rateLimit = new HttpError({
        service: 'raiderio',
        status: 429,
        attempts: 1,
        message: 'slow down',
        retryAfterMs: 1000,
      });

      await expect(
        discoverAlts(
          jobId,
          applicant,
          [applicant],
          [],
          deps({
            getCharacterOwner: owner,
            getClaimedCharacters: vi.fn(async () =>
              claimedList(['Altone', 'Alttwo', 'Altthree', 'Altfour']),
            ),
            getCharacterSummary: vi.fn(async (c) => {
              if (c.name === 'Alttwo') throw rateLimit;
              return { className: 'Mage', guild: null };
            }),
          }),
        ),
      ).rejects.toBe(rateLimit);

      const found = getFindings(jobId).map((f) => f.name);
      // The applicant, the one before the failure, and the failure itself.
      expect(found).toContain('Altone');
      expect(found).toContain('Alttwo');
      // Left unrecorded, so the resumed run derives them WITH their class/guild.
      expect(found).not.toContain('Altthree');
      expect(found).not.toContain('Altfour');
      // The one that failed is recorded, but honestly unenriched.
      expect(getFindings(jobId).find((f) => f.name === 'Alttwo')!.className).toBeNull();
    });

    it('records the claimed characters in list order', async () => {
      const names = ['Zeta', 'Alpha', 'Mu', 'Beta'];
      await discoverAlts(
        jobId,
        applicant,
        [applicant],
        [],
        deps({
          getCharacterOwner: owner,
          getClaimedCharacters: vi.fn(async () => claimedList(names)),
          // Reverse-ordered latency: the last character resolves first.
          getCharacterSummary: vi.fn(async (c) => {
            await new Promise((r) => setTimeout(r, (names.length - names.indexOf(c.name)) * 4));
            return { className: 'Mage', guild: null };
          }),
        }),
      );
      const found = getFindings(jobId).map((f) => f.name);
      expect(found).toEqual([applicant.name, ...names]);
    });
  });

  /**
   * The former-guild walk was 38.0s of a measured 151.9s job: one paced request
   * per claimed character, strictly serially. It now fetches concurrently and
   * extends the frontier in a second, serial pass — because frontier ORDER
   * decides which guilds fall inside maxGuilds, so a completion-ordered frontier
   * would make the sweep's reach vary from run to run.
   */
  describe('former guilds, fetched concurrently', () => {
    const claimed = Array.from({ length: 6 }, (_, i) => ({
      name: `Alt${i}`,
      realm: 'Draenor',
      className: 'Mage',
      level: 80,
    }));

    /** Each character last raided with a guild of its own, named after it. */
    const killDatesPerCharacter = async (c: { name: string }) => [
      {
        bossName: 'imperator-averzian',
        firstDefeated: '2024-12-05T00:00:00.000Z',
        guild: { name: `Guild-${c.name}`, realm: 'silvermoon' },
        raid: null,
      },
    ];

    it('walks the guilds in character order however the fetches resolve', async () => {
      const getGuildRoster = vi.fn(async () => []);
      await discoverAlts(
        jobId,
        applicant,
        [applicant],
        [],
        deps({
          getCharacterOwner: vi.fn(async () => ({
            user: 'brent',
            discordProfile: null,
            declaredMain: null,
          })),
          getClaimedCharacters: vi.fn(async () => claimed),
          getCharacterGuild: vi.fn(async () => null),
          getGuildRoster,
          // Deliberately inverted: the LAST character resolves first.
          getMythicKillDates: vi.fn(async (c) => {
            const n = Number(c.name.replace('Alt', ''));
            await new Promise((r) => setTimeout(r, Number.isNaN(n) ? 30 : (6 - n) * 3));
            return killDatesPerCharacter(c);
          }),
          maxGuilds: 12,
        }),
      );

      const walked = getGuildRoster.mock.calls.map(
        (call) => (call as unknown as [{ name: string }])[0].name,
      );
      expect(walked).toEqual([
        'Guild-Brentpriest',
        'Guild-Alt0',
        'Guild-Alt1',
        'Guild-Alt2',
        'Guild-Alt3',
        'Guild-Alt4',
        'Guild-Alt5',
      ]);
    });

    it('overlaps the fetches', async () => {
      let live = 0;
      let peak = 0;
      await discoverAlts(
        jobId,
        applicant,
        [applicant],
        [],
        deps({
          getCharacterOwner: vi.fn(async () => ({
            user: 'brent',
            discordProfile: null,
            declaredMain: null,
          })),
          getClaimedCharacters: vi.fn(async () => claimed),
          getGuildRoster: vi.fn(async () => []),
          getMythicKillDates: vi.fn(async () => {
            live++;
            peak = Math.max(peak, live);
            await new Promise((r) => setTimeout(r, 10));
            live--;
            return [];
          }),
        }),
      );
      expect(peak).toBeGreaterThan(1);
    });
  });

  it("seeds the BFS from a guild's own realm, not the character's", async () => {
    const getGuildRoster = vi.fn(async () => []);
    await discoverAlts(
      jobId,
      { region: 'eu', realm: 'argent-dawn', name: 'Driptinus' },
      [{ region: 'eu', realm: 'argent-dawn', name: 'Driptinus' }],
      [],
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
      applicant,
      [applicant],
      [],
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
      applicant,
      [applicant],
      [],
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
      applicant,
      [applicant],
      [],
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
      applicant,
      [applicant],
      [],
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

  it('keys one character across all three realm vocabularies, not just casing', async () => {
    // Azjol-Nerub is where the vocabularies genuinely part company: the application
    // carries Raider.IO's slug `azjol-nerub`, a claimed character carries the display
    // name `Azjol-Nerub`, and a Blizzard roster carries `azjolnerub` — Blizzard deletes
    // the hyphen. Space-to-hyphen normalisation left the first two agreeing and the
    // third on a row of its own, stripped of class and guild because Raider.IO cannot
    // read `azjolnerub` back.
    const onAzjolNerub = { region: 'eu', realm: 'azjol-nerub', name: 'Brentpriest' };
    const job = createJob({ applicationId: 2, targetChannelId: '1', character: onAzjolNerub });

    await discoverAlts(
      job,
      onAzjolNerub,
      [onAzjolNerub],
      [],
      deps({
        getCharacterOwner: vi.fn(async () => ({
          user: 'Brentoan',
          discordProfile: 'brent',
          declaredMain: null,
        })),
        getClaimedCharacters: vi.fn(async () => [
          { name: 'Brenthunter', realm: 'Azjol-Nerub', className: 'Hunter', level: 90 },
        ]),
        getCharacterGuild: vi.fn(async () => ({ name: 'Rancour', realm: 'Azjol-Nerub' })),
        getGuildRoster: vi.fn(async () => [
          { name: 'Brenthunter', realm: 'azjolnerub' },
          { name: 'Brentpriest', realm: 'azjolnerub' },
        ]),
      }),
    );

    const found = getFindings(job);
    expect(found.filter((f) => f.name === 'Brenthunter')).toHaveLength(1);
    expect(found.filter((f) => f.name === 'Brentpriest')).toHaveLength(1);
  });

  it("records realms in Raider.IO's vocabulary, so the finding can be read back", async () => {
    // A claimed character arrives as `Zul'jin`. Lowercasing it gives `zul'jin`, which
    // Raider.IO 404s — so the finding used to be both looked up and stored under a
    // realm nothing could resolve, which is why the duplicate row carried no class.
    const onZuljin = { region: 'eu', realm: 'zuljin', name: 'Brentpriest' };
    const job = createJob({ applicationId: 3, targetChannelId: '1', character: onZuljin });
    const getCharacterSummary = vi.fn(async () => ({ className: 'Hunter', guild: null }));

    await discoverAlts(
      job,
      onZuljin,
      [onZuljin],
      [],
      deps({
        getCharacterSummary,
        getCharacterOwner: vi.fn(async () => ({
          user: 'Brentoan',
          discordProfile: 'brent',
          declaredMain: null,
        })),
        getClaimedCharacters: vi.fn(async () => [
          { name: 'Brenthunter', realm: "Zul'jin", className: 'Hunter', level: 90 },
        ]),
      }),
    );

    const hunter = getFindings(job).find((f) => f.name === 'Brenthunter');
    expect(hunter?.realm).toBe('zuljin');
    expect(hunter?.className).toBe('Hunter');
    // The lookup itself must use that spelling too, or it returns nothing to store.
    expect(getCharacterSummary).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Brenthunter', realm: 'zuljin' }),
    );
  });

  it('reports truncated when the applicant fingerprint itself is unavailable, even with nothing left to walk', async () => {
    // No guild, no roster, nothing left in the frontier — the only reason
    // truncation could be reported is the missing applicant baseline itself.
    const result = await discoverAlts(
      jobId,
      applicant,
      [applicant],
      [],
      deps({
        getAnchorFingerprint: vi.fn(async () => null),
      }),
    );
    expect(result.truncated).toBe(true);
  });

  it('marks nothing scanned for roster members when the applicant fingerprint is unavailable', async () => {
    await discoverAlts(
      jobId,
      applicant,
      [applicant],
      [],
      deps({
        getCharacterGuild: vi.fn(async () => ({ name: 'Rancour', realm: 'Draenor' })),
        getGuildRoster: vi.fn(async () => [{ name: 'Brenthunter', realm: 'Draenor' }]),
        getAnchorFingerprint: vi.fn(async () => null),
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
        applicant,
        [applicant],
        [],
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
        applicant,
        [applicant],
        [],
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
        applicant,
        [applicant],
        [],
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
    await expect(
      discoverAlts(jobId, applicant, [applicant], [], deps({ getCharacterSummary })),
    ).rejects.toThrow(HttpError);
    expect(getFindings(jobId).map((f) => f.name)).toEqual(['Brentpriest']);
  });
});

describe('discoverAlts — a mid-batch rate limit keeps the matches already found', () => {
  let jobId: number;
  beforeEach(() => {
    createTables(getDatabase(':memory:'));
    jobId = createJob({ applicationId: 1, targetChannelId: '1', character: applicant });
  });
  afterEach(() => closeDatabase());

  /**
   * markScanned lands per member as each fingerprint resolves, but mapLimit
   * discards its whole result array when a sibling worker rejects. So a 429
   * arriving part-way through a ~600-member guild roster used to lose every match
   * found earlier in that same batch, while leaving those characters marked
   * scanned — permanently excluded from the resumed run. Same defect class as the
   * no-fingerprint path, just narrower.
   */
  it('records an earlier match even though a later member is rate limited', async () => {
    const getCharacterFingerprint = vi.fn(async (c: { name: string }) => {
      if (c.name === 'Ratelimited') {
        throw new HttpError({
          service: 'blizzard',
          status: 429,
          attempts: 1,
          message: 'slow down',
          retryAfterMs: 60_000,
        });
      }
      return fingerprints[c.name.toLowerCase()] ?? null;
    });

    await expect(
      discoverAlts(
        jobId,
        applicant,
        [applicant],
        [],
        deps({
          getCharacterGuild: vi.fn(async () => ({ name: 'Rancour', realm: 'Draenor' })),
          getGuildRoster: vi.fn(async () => [
            { name: 'Brenthunter', realm: 'Draenor' },
            { name: 'Ratelimited', realm: 'Draenor' },
          ]),
          getCharacterFingerprint,
        }),
      ),
    ).rejects.toBeInstanceOf(HttpError);

    // The match found before the rate limit must survive the pause.
    expect(getFindings(jobId).map((f) => f.name)).toContain('Brenthunter');
  });

  /**
   * `discover` was 50.4s of a measured 160.8s job and five different sources feed
   * it, so one number could not say which. The marks are optional and namespaced
   * `d.*` so they read as a breakdown of that figure rather than peers of it.
   */
  describe('sub-phase timings', () => {
    it('reports a breakdown, and counts of what the sweep actually did', async () => {
      const timings = new PhaseTimings();
      await discoverAlts(
        jobId,
        applicant,
        [applicant],
        [],
        deps({
          timings,
          getCharacterGuild: vi.fn(async () => ({ name: 'Rancour', realm: 'Draenor' })),
          getGuildRoster: vi.fn(async () => [{ name: 'Brenthunter', realm: 'Draenor' }]),
        }),
      );

      const summary = timings.summary();
      for (const phase of [
        'd.named',
        'd.owner',
        'd.ownGuild',
        'd.formerGuilds',
        'd.primaryFp',
        'd.rosters',
        'd.fingerprints',
        'd.matches',
      ]) {
        expect(summary).toContain(phase);
      }
      expect(summary).toContain('dGuilds=1');
      expect(summary).toContain('dFingerprinted=1');
    });

    /** A paused sweep is the run whose cost most needs explaining. */
    it('still reports its counts when the sweep pauses on a rate limit', async () => {
      const timings = new PhaseTimings();
      await discoverAlts(
        jobId,
        applicant,
        [applicant],
        [],
        deps({
          timings,
          getCharacterGuild: vi.fn(async () => ({ name: 'Rancour', realm: 'Draenor' })),
          getGuildRoster: vi.fn(async () => [{ name: 'Ratelimited', realm: 'Draenor' }]),
          getCharacterFingerprint: vi.fn(async (c) => {
            if (c.name === 'Ratelimited') {
              throw new HttpError({
                service: 'blizzard',
                status: 429,
                attempts: 1,
                message: 'slow down',
                retryAfterMs: 1000,
              });
            }
            return fingerprints[c.name.toLowerCase()] ?? null;
          }),
        }),
      ).catch(() => {});

      expect(timings.summary()).toContain('dGuilds=1');
    });

    it('works without a timings object at all', async () => {
      await expect(discoverAlts(jobId, applicant, [applicant], [], deps())).resolves.toEqual({
        truncated: false,
      });
    });
  });
});

describe('a sweep rooted on a character nobody declared', () => {
  let jobId: number;
  beforeEach(() => {
    createTables(getDatabase(':memory:'));
    jobId = createJob({ applicationId: 1, targetChannelId: '1', character: applicant });
  });
  afterEach(() => closeDatabase());

  /**
   * An application that named nobody is rescued by a pasted link, which becomes
   * the job's primary. The primary is only the identity the fingerprint anchors
   * on — it is NOT a self-declaration. Conflating the two would render a URL
   * someone pasted as "from the application" at 100% confidence and skip the
   * Discord confirmation pass that exists to check exactly that kind of guess.
   */
  it('attributes a rescued primary to the link, not the application', async () => {
    await discoverAlts(jobId, applicant, [], [applicant], deps());

    const found = getFindings(jobId);
    expect(found).toHaveLength(1);
    expect(found[0].source).toBe('linked');
  });

  it('does nothing when neither source names anyone', async () => {
    await expect(discoverAlts(jobId, applicant, [], [], deps())).resolves.toEqual({
      truncated: false,
    });
    expect(getFindings(jobId)).toEqual([]);
  });
});

describe('linked seeds are interrogated for further sources', () => {
  let jobId: number;
  beforeEach(() => {
    createTables(getDatabase(':memory:'));
    jobId = createJob({ applicationId: 1, targetChannelId: '1', character: applicant });
  });
  afterEach(() => closeDatabase());

  /**
   * Provenance decides how a finding is LABELLED, not whether it deserves an
   * owner lookup. A rescued job has no declared characters at all, so restricting
   * these loops to `applicants` skipped the claimed-character list and declared
   * main — the two highest-confidence sources — for exactly the applications this
   * feature exists to rescue.
   */
  it('runs the owner lookup on a linked character when nothing was declared', async () => {
    const getCharacterOwner = vi.fn(async () => ({
      user: 'Brentoan',
      discordProfile: 'brent',
      declaredMain: null,
    }));
    const getCharacterGuild = vi.fn(async () => null);

    await discoverAlts(
      jobId,
      applicant,
      [],
      [applicant],
      deps({
        getCharacterOwner,
        getCharacterGuild,
        getClaimedCharacters: vi.fn(async () => [
          { name: 'Brenthunter', realm: 'Draenor', className: 'Hunter', level: 90 },
        ]),
      }),
    );

    expect(getCharacterOwner).toHaveBeenCalledWith(applicant);
    expect(getCharacterGuild).toHaveBeenCalledWith(applicant);
    expect(getFindings(jobId).find((f) => f.name === 'Brenthunter')?.source).toBe('raider.io');
  });
});

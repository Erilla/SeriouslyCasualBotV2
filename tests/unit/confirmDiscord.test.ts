import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { closeDatabase, getDatabase } from '../../src/database/db.js';
import { createTables } from '../../src/database/schema.js';

vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  createJob,
  addFinding,
  getFindings,
  type IntelFinding,
} from '../../src/functions/applications/intel/jobStore.js';
import {
  confirmDiscord,
  type ConfirmDeps,
} from '../../src/functions/applications/alts/confirmDiscord.js';

const applicant = { region: 'eu', realm: 'draenor', name: 'Regnipaw' };

const finding = (name: string, over: Partial<IntelFinding> = {}): IntelFinding => ({
  name,
  realm: 'Draenor',
  className: 'Monk',
  guildName: 'Rancour',
  guildRealm: 'Draenor',
  source: 'fingerprint',
  confidence: 93,
  discordStatus: null,
  discordProfile: null,
  ...over,
});

function deps(handles: Record<string, string | null>): ConfirmDeps {
  return {
    getCharacterOwner: vi.fn(async (c) => ({
      user: null,
      discordProfile: handles[c.name] ?? null,
      declaredMain: null,
    })),
    paceMs: 0,
  };
}

describe('confirmDiscord', () => {
  let jobId: number;
  beforeEach(() => {
    createTables(getDatabase(':memory:'));
    jobId = createJob({ applicationId: 1, targetChannelId: 'c', character: applicant });
  });
  afterEach(() => closeDatabase());

  it('confirms a character whose Discord handle matches, case-insensitively', async () => {
    addFinding(jobId, finding('Monkni'));
    const result = await confirmDiscord(jobId, 'eu', 'Binded', deps({ Monkni: 'binded' }));

    expect(result).toEqual({ confirmed: 1, mismatched: 0, backLinked: 0 });
    const stored = getFindings(jobId).find((f) => f.name === 'Monkni')!;
    expect(stored.discordStatus).toBe('confirmed');
    expect(stored.discordProfile).toBe('binded');
  });

  it('flags a mismatch and records the handle it saw', async () => {
    addFinding(jobId, finding('Someoneelse'));
    const result = await confirmDiscord(jobId, 'eu', 'binded', deps({ Someoneelse: 'notthem' }));

    expect(result).toEqual({ confirmed: 0, mismatched: 1, backLinked: 0 });
    const stored = getFindings(jobId).find((f) => f.name === 'Someoneelse')!;
    expect(stored.discordStatus).toBe('mismatch');
    expect(stored.discordProfile).toBe('notthem');
  });

  it('leaves the status unset when the character exposes no handle', async () => {
    addFinding(jobId, finding('Quiet'));
    await confirmDiscord(jobId, 'eu', 'binded', deps({ Quiet: null }));
    expect(getFindings(jobId).find((f) => f.name === 'Quiet')!.discordStatus).toBeNull();
  });

  it('skips characters the applicant named themselves', async () => {
    addFinding(jobId, finding('Regnipaw', { source: 'application', confidence: null }));
    const d = deps({ Regnipaw: 'binded' });
    await confirmDiscord(jobId, 'eu', 'binded', d);
    expect(d.getCharacterOwner).not.toHaveBeenCalled();
  });

  /**
   * The lookup still happens — it is what finds the declared-main back-link — but
   * with no handle to compare against there is nothing to confirm or contradict.
   */
  it('records no Discord verdict when the applicant handle is unknown', async () => {
    addFinding(jobId, finding('Monkni'));
    const d = deps({ Monkni: 'binded' });
    const result = await confirmDiscord(jobId, 'eu', null, d);

    expect(result).toEqual({ confirmed: 0, mismatched: 0, backLinked: 0 });
    expect(getFindings(jobId).find((f) => f.name === 'Monkni')!.discordStatus).toBeNull();
  });

  it('keeps going when one lookup throws', async () => {
    addFinding(jobId, finding('Broken'));
    addFinding(jobId, finding('Fine'));
    const getCharacterOwner = vi.fn(async (c: { name: string }) => {
      if (c.name === 'Broken') throw new Error('boom');
      return { user: null, discordProfile: 'binded', declaredMain: null };
    });

    const result = await confirmDiscord(jobId, 'eu', 'binded', {
      getCharacterOwner: getCharacterOwner as ConfirmDeps['getCharacterOwner'],
      paceMs: 0,
    });

    expect(result.confirmed).toBe(1);
    expect(getFindings(jobId).find((f) => f.name === 'Broken')!.discordStatus).toBeNull();
  });

  /**
   * The reverse of `declared main`, which discoverAlts only ever reads forwards
   * ("who does the applicant say their main is?"). Raider.IO records the claim on
   * the ALT — Dragonii-Aggra Português names Xplendor as its main, while Xplendor
   * names nobody — and this pass already fetches exactly that payload for the
   * Discord handle, so the strongest evidence there is was being discarded.
   */
  describe('declared-main back-link', () => {
    const backLink = (main: { name: string; realm: string } | null): ConfirmDeps => ({
      getCharacterOwner: vi.fn(async () => ({
        user: null,
        discordProfile: null,
        declaredMain: main ? { region: 'eu', ...main } : null,
      })),
      paceMs: 0,
    });

    it('upgrades a fingerprint match that names an applicant character as its main', async () => {
      addFinding(jobId, finding('Regnipaw', { source: 'application', confidence: null }));
      addFinding(jobId, finding('Dragonii', { confidence: 79 }));

      const result = await confirmDiscord(
        jobId,
        'eu',
        'binded',
        backLink({ name: 'Regnipaw', realm: 'draenor' }),
      );

      const stored = getFindings(jobId).find((f) => f.name === 'Dragonii')!;
      expect(stored.source).toBe('declared alt');
      expect(stored.confidence).toBe(100);
      expect(result.backLinked).toBe(1);
    });

    /**
     * The sources disagree on realm format — findings hold a slug, Raider.IO's
     * main_character hands back whatever the path carried — so an exact string
     * compare would silently never match.
     */
    it('matches the applicant across realm display-name and slug forms', async () => {
      addFinding(
        jobId,
        finding('Regnipaw', { source: 'application', confidence: null, realm: 'tarren-mill' }),
      );
      addFinding(jobId, finding('Dragonii'));

      await confirmDiscord(
        jobId,
        'eu',
        'binded',
        backLink({ name: 'Regnipaw', realm: 'Tarren Mill' }),
      );

      expect(getFindings(jobId).find((f) => f.name === 'Dragonii')!.source).toBe('declared alt');
    });

    it('ignores a main that is not one of the applicant characters', async () => {
      addFinding(jobId, finding('Regnipaw', { source: 'application', confidence: null }));
      addFinding(jobId, finding('Stranger'));

      const result = await confirmDiscord(
        jobId,
        'eu',
        'binded',
        backLink({ name: 'Someoneelse', realm: 'draenor' }),
      );

      expect(getFindings(jobId).find((f) => f.name === 'Stranger')!.source).toBe('fingerprint');
      expect(result.backLinked).toBe(0);
    });

    /**
     * The pass used to return immediately without a handle, so an application
     * with no Discord given never got the back-link either — the one signal that
     * does not depend on Discord at all.
     */
    it('still finds the back-link when the applicant gave no Discord handle', async () => {
      addFinding(jobId, finding('Regnipaw', { source: 'application', confidence: null }));
      addFinding(jobId, finding('Dragonii'));

      const result = await confirmDiscord(
        jobId,
        'eu',
        null,
        backLink({ name: 'Regnipaw', realm: 'draenor' }),
      );

      expect(getFindings(jobId).find((f) => f.name === 'Dragonii')!.source).toBe('declared alt');
      expect(result).toEqual({ confirmed: 0, mismatched: 0, backLinked: 1 });
    });

    /** An upgrade rewrites the row; the verdict recorded from the same payload must survive it. */
    it('keeps the Discord verdict when the same character is also back-linked', async () => {
      addFinding(jobId, finding('Regnipaw', { source: 'application', confidence: null }));
      addFinding(jobId, finding('Dragonii'));

      await confirmDiscord(jobId, 'eu', 'binded', {
        getCharacterOwner: vi.fn(async () => ({
          user: null,
          discordProfile: 'binded',
          declaredMain: { region: 'eu', realm: 'draenor', name: 'Regnipaw' },
        })),
        paceMs: 0,
      });

      const stored = getFindings(jobId).find((f) => f.name === 'Dragonii')!;
      expect(stored.source).toBe('declared alt');
      expect(stored.discordStatus).toBe('confirmed');
      expect(stored.discordProfile).toBe('binded');
    });

    /** Enrichment already on the row must not be blanked by the upgrade write. */
    it('preserves the class and guild already recorded for the character', async () => {
      addFinding(jobId, finding('Regnipaw', { source: 'application', confidence: null }));
      addFinding(jobId, finding('Dragonii', { className: 'Evoker', guildName: 'Killing Pixels' }));

      await confirmDiscord(jobId, 'eu', null, backLink({ name: 'Regnipaw', realm: 'draenor' }));

      const stored = getFindings(jobId).find((f) => f.name === 'Dragonii')!;
      expect(stored.className).toBe('Evoker');
      expect(stored.guildName).toBe('Killing Pixels');
    });
  });

  /**
   * The first job to run this pass for real spent 88.5s of 151.9s in it — one
   * paced request per character, strictly serially. The lookups now overlap, and
   * every verdict must survive that.
   */
  describe('concurrency', () => {
    it('overlaps the lookups and still records every verdict', async () => {
      const names = Array.from({ length: 9 }, (_, i) => `Alt${i}`);
      for (const n of names) addFinding(jobId, finding(n));

      let live = 0;
      let peak = 0;
      const result = await confirmDiscord(jobId, 'eu', 'binded', {
        getCharacterOwner: (async (c: { name: string }) => {
          live++;
          peak = Math.max(peak, live);
          await new Promise((r) => setTimeout(r, 5));
          live--;
          // Half match the applicant, half belong to someone else.
          const n = Number(c.name.replace('Alt', ''));
          return {
            user: null,
            discordProfile: n % 2 === 0 ? 'binded' : 'somebodyelse',
            declaredMain: null,
          };
        }) as ConfirmDeps['getCharacterOwner'],
        paceMs: 0,
      });

      expect(peak).toBeGreaterThan(1);
      expect(result).toEqual({ confirmed: 5, mismatched: 4, backLinked: 0 });
      const stored = getFindings(jobId);
      expect(stored.filter((f) => f.discordStatus === 'confirmed')).toHaveLength(5);
      expect(stored.filter((f) => f.discordStatus === 'mismatch')).toHaveLength(4);
    });

    /**
     * A rejection must be caught INSIDE the worker: escaping it would cancel the
     * whole batch, and a character never looked at would read as one exposing no
     * handle.
     */
    it('one throwing lookup does not lose the concurrent ones', async () => {
      const names = ['Broken', ...Array.from({ length: 6 }, (_, i) => `Alt${i}`)];
      for (const n of names) addFinding(jobId, finding(n));

      const result = await confirmDiscord(jobId, 'eu', 'binded', {
        getCharacterOwner: (async (c: { name: string }) => {
          if (c.name === 'Broken') throw new Error('boom');
          await new Promise((r) => setTimeout(r, 5));
          return { user: null, discordProfile: 'binded', declaredMain: null };
        }) as ConfirmDeps['getCharacterOwner'],
        paceMs: 0,
      });

      expect(result.confirmed).toBe(6);
    });

    /** The pace is per worker, so it must not have been dropped along the way. */
    it('still paces each worker', async () => {
      for (const n of ['A', 'B']) addFinding(jobId, finding(n));
      const started = Date.now();
      await confirmDiscord(jobId, 'eu', 'binded', {
        getCharacterOwner: (async () => ({
          user: null,
          discordProfile: 'binded',
          declaredMain: null,
        })) as ConfirmDeps['getCharacterOwner'],
        paceMs: 30,
      });
      expect(Date.now() - started).toBeGreaterThanOrEqual(30);
    });
  });
});

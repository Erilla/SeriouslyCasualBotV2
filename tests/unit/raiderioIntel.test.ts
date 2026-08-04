import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/services/httpClient.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/httpClient.js')>();
  return { ...actual, httpRequest: vi.fn() };
});

import { httpRequest, HttpError, CircuitOpenError } from '../../src/services/httpClient.js';
import {
  getCharacterGuild,
  getCharacterSummary,
  getMythicKillCount,
} from '../../src/services/raiderio.js';

const mocked = vi.mocked(httpRequest);
const character = { region: 'eu', realm: 'argent-dawn', name: 'Driptinus' };

beforeEach(() => mocked.mockReset());

describe('getCharacterGuild', () => {
  it("returns the guild's own realm, not the character's", async () => {
    mocked.mockResolvedValueOnce({
      name: 'Driptinus',
      guild: { name: 'Rancour', realm: 'Draenor' },
    } as never);
    expect(await getCharacterGuild(character)).toEqual({ name: 'Rancour', realm: 'Draenor' });
  });

  it('returns null for a guildless character', async () => {
    mocked.mockResolvedValueOnce({ name: 'Driptinus' } as never);
    expect(await getCharacterGuild(character)).toBeNull();
  });

  it('returns null when Raider.IO 404s the character', async () => {
    mocked.mockRejectedValueOnce(
      new HttpError({ service: 'raiderio', status: 404, attempts: 1, message: 'not found' }),
    );
    expect(await getCharacterGuild(character)).toBeNull();
  });

  // FINAL REVIEW M5: this lookup seeds discoverAlts' guild frontier, so a
  // swallowed rate limit empties the frontier and publishes an affirmative
  // "no undeclared characters" for a sweep that walked no guild at all.
  it('rethrows a 429 instead of swallowing it as "no guild"', async () => {
    mocked.mockRejectedValueOnce(
      new HttpError({
        service: 'raiderio',
        status: 429,
        attempts: 1,
        message: 'rate limited',
        retryAfterMs: 60_000,
      }),
    );
    await expect(getCharacterGuild(character)).rejects.toBeInstanceOf(HttpError);
  });

  // The retry-exhaustion path reports the LAST status, so 429/429/503 arrives
  // as 503; retryAfterMs is what still identifies it as rate limited.
  it('rethrows a retry-exhausted rate limit reported under another status', async () => {
    mocked.mockRejectedValueOnce(
      new HttpError({
        service: 'raiderio',
        status: 503,
        attempts: 3,
        message: 'unavailable',
        retryAfterMs: 30_000,
      }),
    );
    await expect(getCharacterGuild(character)).rejects.toBeInstanceOf(HttpError);
  });

  it('rethrows an open circuit', async () => {
    mocked.mockRejectedValueOnce(new CircuitOpenError('raiderio'));
    await expect(getCharacterGuild(character)).rejects.toBeInstanceOf(CircuitOpenError);
  });
});

describe('getCharacterSummary', () => {
  it('returns class and guild together', async () => {
    mocked.mockResolvedValueOnce({
      name: 'Driptinus',
      class: 'Shaman',
      guild: { name: 'Rancour', realm: 'Draenor' },
    } as never);
    expect(await getCharacterSummary(character)).toEqual({
      className: 'Shaman',
      guild: { name: 'Rancour', realm: 'Draenor' },
    });
  });

  it('returns null for an ordinary 404, which really is "unknown"', async () => {
    mocked.mockRejectedValueOnce(
      new HttpError({ service: 'raiderio', status: 404, attempts: 1, message: 'not found' }),
    );
    expect(await getCharacterSummary(character)).toBeNull();
  });

  // FINAL REVIEW M5: record() seeds the guild frontier exclusively from
  // summary.guild, so this is the primary route by which a swallowed 429
  // becomes a false "only the declared characters exist".
  it('rethrows a 429 instead of swallowing it as "no guild"', async () => {
    mocked.mockRejectedValueOnce(
      new HttpError({
        service: 'raiderio',
        status: 429,
        attempts: 1,
        message: 'rate limited',
        retryAfterMs: 60_000,
      }),
    );
    await expect(getCharacterSummary(character)).rejects.toBeInstanceOf(HttpError);
  });

  it('rethrows an open circuit', async () => {
    mocked.mockRejectedValueOnce(new CircuitOpenError('raiderio'));
    await expect(getCharacterSummary(character)).rejects.toBeInstanceOf(CircuitOpenError);
  });
});

describe('getMythicKillCount', () => {
  it('sums mythic_bosses_killed across raids', async () => {
    mocked.mockResolvedValueOnce({
      raid_progression: {
        'tier-mn-1': { mythic_bosses_killed: 7, total_bosses: 9 },
        sporefall: { mythic_bosses_killed: 1, total_bosses: 1 },
      },
    } as never);
    expect(await getMythicKillCount(character)).toBe(8);
  });

  it('returns 0 rather than throwing when the lookup fails', async () => {
    mocked.mockRejectedValueOnce(
      new HttpError({ service: 'raiderio', status: 500, attempts: 3, message: 'boom' }),
    );
    expect(await getMythicKillCount(character)).toBe(0);
  });

  // Deliberate asymmetry with the two lookups above: this one is only a
  // prioritiser for which alts get a WCL sweep, so a rate limit here costs
  // ordering, never a false absence — it must NOT pause the job.
  it('keeps swallowing a 429, because it only prioritises', async () => {
    mocked.mockRejectedValueOnce(
      new HttpError({
        service: 'raiderio',
        status: 429,
        attempts: 1,
        message: 'rate limited',
        retryAfterMs: 60_000,
      }),
    );
    expect(await getMythicKillCount(character)).toBe(0);
  });
});

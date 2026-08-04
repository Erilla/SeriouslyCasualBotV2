import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../src/services/httpClient.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/httpClient.js')>();
  return { ...actual, httpRequest: vi.fn() };
});
vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { httpRequest, HttpError, CircuitOpenError } from '../../src/services/httpClient.js';
import { closeDatabase, getDatabase } from '../../src/database/db.js';
import { createTables } from '../../src/database/schema.js';
import { getCharacterFingerprint, getBlizzardGuildRoster } from '../../src/services/blizzard.js';
import { pruneCache } from '../../src/services/apiCache.js';

const mocked = vi.mocked(httpRequest);
const character = { region: 'eu', realm: 'argent-dawn', name: 'Driptinus' };
const achievements = {
  achievements: [
    { id: 1, completed_timestamp: 1_700_000_000_000 },
    { id: 2, completed_timestamp: 1_700_000_000_001 },
    { id: 3 }, // incomplete — excluded
  ],
};

// getAccessToken() caches the OAuth token at module scope for the life of this
// file, so it only ever calls httpRequest once. Prime it here, outside every
// test's own mock queue, so every other test's mockResolvedValueOnce/
// mockRejectedValueOnce lines up with the achievements/roster call it's
// meant for, not an incidental token fetch.
beforeAll(async () => {
  createTables(getDatabase(':memory:'));
  mocked.mockResolvedValueOnce({ access_token: 'warmup-token', expires_in: 3600 } as never);
  mocked.mockResolvedValueOnce({ achievements: [] } as never);
  await getCharacterFingerprint(character);
  mocked.mockReset();
  closeDatabase();
});

describe('getCharacterFingerprint', () => {
  beforeEach(() => {
    mocked.mockReset();
    createTables(getDatabase(':memory:'));
  });
  afterEach(() => closeDatabase());

  it('maps completed achievements to timestamps', async () => {
    mocked.mockResolvedValueOnce(achievements as never);
    const fp = await getCharacterFingerprint(character);
    expect([...fp!.entries()]).toEqual([
      [1, 1_700_000_000_000],
      [2, 1_700_000_000_001],
    ]);
  });

  it('serves the same character from the cache, surviving the Map round-trip', async () => {
    mocked.mockResolvedValueOnce(achievements as never);
    await getCharacterFingerprint(character);
    const cached = await getCharacterFingerprint(character);
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(cached).toBeInstanceOf(Map);
    expect(cached!.get(1)).toBe(1_700_000_000_000);
  });

  it('returns null for an unreadable character without caching it', async () => {
    mocked.mockRejectedValueOnce(
      new HttpError({ service: 'blizzard', status: 404, attempts: 1, message: 'gone' }),
    );
    expect(await getCharacterFingerprint(character)).toBeNull();

    mocked.mockResolvedValueOnce(achievements as never);
    expect(await getCharacterFingerprint(character)).not.toBeNull();
  });

  it('rethrows a 429 so the job pauses instead of reporting no alts', async () => {
    mocked.mockRejectedValueOnce(
      new HttpError({ service: 'blizzard', status: 429, attempts: 3, message: 'slow down' }),
    );
    await expect(getCharacterFingerprint(character)).rejects.toBeInstanceOf(HttpError);
  });

  it('rethrows an open circuit', async () => {
    mocked.mockRejectedValueOnce(new CircuitOpenError('blizzard'));
    await expect(getCharacterFingerprint(character)).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it('rethrows a mixed-status retry storm (429 then 503) instead of reporting no alts', async () => {
    // httpRequest's retry-exhaustion path throws with the LAST status seen,
    // so a run rate-limited on early attempts but failing with 503 on the
    // final one surfaces as status 503 with retryAfterMs still set from the
    // earlier 429. status===429 alone would miss this and swallow it to null.
    mocked.mockRejectedValueOnce(
      new HttpError({
        service: 'blizzard',
        status: 503,
        attempts: 3,
        message: 'server error after rate limiting',
        retryAfterMs: 2_000,
      }),
    );
    await expect(getCharacterFingerprint(character)).rejects.toBeInstanceOf(HttpError);
  });

  it('returns null when the character has no completed achievements', async () => {
    mocked.mockResolvedValueOnce({ achievements: [] } as never);
    expect(await getCharacterFingerprint(character)).toBeNull();
  });
});

describe('getBlizzardGuildRoster', () => {
  beforeEach(() => {
    mocked.mockReset();
    createTables(getDatabase(':memory:'));
  });
  afterEach(() => closeDatabase());

  it('slugifies guild name and realm, mapping members to name/realm', async () => {
    mocked.mockResolvedValueOnce({
      members: [
        { character: { name: 'Dodsleif', realm: { slug: 'silvermoon' } } },
        { character: { name: 'Skogslisa', realm: { slug: 'silvermoon' } } },
        { character: { name: 'NoRealm' } },
      ],
    } as never);

    const roster = await getBlizzardGuildRoster('eu', 'Tarren Mill', 'Seriously Casual');

    expect(roster).toEqual([
      { name: 'Dodsleif', realm: 'silvermoon' },
      { name: 'Skogslisa', realm: 'silvermoon' },
    ]);
    const url = String(mocked.mock.calls.at(-1)?.[1]);
    expect(url).toContain('/data/wow/guild/tarren-mill/seriously-casual/roster');
    expect(url).toContain('namespace=profile-eu');
  });

  it('returns an empty array rather than throwing when a guild cannot be read', async () => {
    mocked.mockRejectedValueOnce(
      new HttpError({ service: 'blizzard', status: 404, attempts: 1, message: 'gone' }),
    );
    expect(await getBlizzardGuildRoster('eu', 'silvermoon', 'Nope')).toEqual([]);
  });

  it('rethrows a 429 so the job pauses', async () => {
    mocked.mockRejectedValueOnce(
      new HttpError({ service: 'blizzard', status: 429, attempts: 3, message: 'slow down' }),
    );
    await expect(getBlizzardGuildRoster('eu', 'silvermoon', 'Nope')).rejects.toBeInstanceOf(
      HttpError,
    );
  });

  it('rethrows an open circuit', async () => {
    mocked.mockRejectedValueOnce(new CircuitOpenError('blizzard'));
    await expect(getBlizzardGuildRoster('eu', 'silvermoon', 'Nope')).rejects.toBeInstanceOf(
      CircuitOpenError,
    );
  });

  it('rethrows a mixed-status retry storm (429 then 503) instead of reporting an empty guild', async () => {
    // Same rationale as the fingerprint case: the thrown error's status is
    // the LAST one seen (503), not 429, so only retryAfterMs distinguishes
    // this from a genuine non-rate-limited failure.
    mocked.mockRejectedValueOnce(
      new HttpError({
        service: 'blizzard',
        status: 503,
        attempts: 3,
        message: 'server error after rate limiting',
        retryAfterMs: 2_000,
      }),
    );
    await expect(getBlizzardGuildRoster('eu', 'silvermoon', 'Nope')).rejects.toBeInstanceOf(
      HttpError,
    );
  });

  it('serves the same guild from the cache (one fetch only)', async () => {
    mocked.mockResolvedValueOnce({
      members: [{ character: { name: 'Dodsleif', realm: { slug: 'silvermoon' } } }],
    } as never);
    await getBlizzardGuildRoster('eu', 'Tarren Mill', 'Seriously Casual');
    const roster = await getBlizzardGuildRoster('eu', 'Tarren Mill', 'Seriously Casual');
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(roster).toEqual([{ name: 'Dodsleif', realm: 'silvermoon' }]);
  });

  it('does not cache a failure as an empty guild', async () => {
    mocked.mockRejectedValueOnce(
      new HttpError({ service: 'blizzard', status: 500, attempts: 1, message: 'boom' }),
    );
    expect(await getBlizzardGuildRoster('eu', 'Tarren Mill', 'Seriously Casual')).toEqual([]);

    mocked.mockResolvedValueOnce({
      members: [{ character: { name: 'Dodsleif', realm: { slug: 'silvermoon' } } }],
    } as never);
    const roster = await getBlizzardGuildRoster('eu', 'Tarren Mill', 'Seriously Casual');
    expect(roster).toEqual([{ name: 'Dodsleif', realm: 'silvermoon' }]);
    expect(mocked).toHaveBeenCalledTimes(2);
  });
});

describe('pruneCache', () => {
  beforeEach(() => createTables(getDatabase(':memory:')));
  afterEach(() => closeDatabase());

  it('removes only stale entries under the given prefix', () => {
    const db = getDatabase();
    const old = new Date(Date.now() - 60_000).toISOString();
    const insert = db.prepare('INSERT INTO api_cache (key, payload, fetched_at) VALUES (?, ?, ?)');
    insert.run('fingerprint:eu:draenor:old', '[]', old);
    insert.run('fingerprint:eu:draenor:fresh', '[]', new Date().toISOString());
    insert.run('static-data:10', '{}', old);

    expect(pruneCache('fingerprint:', 30_000)).toBe(1);
    const keys = (db.prepare('SELECT key FROM api_cache').all() as { key: string }[]).map(
      (r) => r.key,
    );
    expect(keys).toEqual(
      expect.arrayContaining(['fingerprint:eu:draenor:fresh', 'static-data:10']),
    );
    expect(keys).toHaveLength(2);
  });
});

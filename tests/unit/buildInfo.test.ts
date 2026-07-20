import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getDatabase, closeDatabase } from '../../src/database/db.js';
import { createTables } from '../../src/database/schema.js';

vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { getBuildInfo } from '../../src/services/buildInfo.js';
import { logger } from '../../src/services/logger.js';

const SHA = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';

function linkHeader(count: number): string {
  return (
    `<https://api.github.com/repositories/1/commits?sha=${SHA}&per_page=1&page=2>; rel="next", ` +
    `<https://api.github.com/repositories/1/commits?sha=${SHA}&per_page=1&page=${count}>; rel="last"`
  );
}

function okResponse(link: string | null): { ok: boolean; headers: Headers } {
  const headers = new Headers();
  if (link) headers.set('link', link);
  return { ok: true, headers };
}

beforeEach(() => {
  closeDatabase();
  const db = getDatabase(':memory:');
  createTables(db);
  vi.clearAllMocks();
});

afterEach(() => {
  closeDatabase();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('getBuildInfo — Railway path', () => {
  it('resolves the build number from the Link header and caches it', async () => {
    vi.stubEnv('RAILWAY_GIT_COMMIT_SHA', SHA);
    const fetchMock = vi.fn().mockResolvedValue(okResponse(linkHeader(171)));
    vi.stubGlobal('fetch', fetchMock);

    const info = await getBuildInfo();

    expect(info).toEqual({ build: 171, sha: SHA });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toContain(`sha=${SHA}`);

    const row = getDatabase().prepare('SELECT build FROM build_info WHERE sha = ?').get(SHA) as {
      build: number;
    };
    expect(row.build).toBe(171);
  });

  it('returns the cached build without calling fetch', async () => {
    vi.stubEnv('RAILWAY_GIT_COMMIT_SHA', SHA);
    getDatabase().prepare('INSERT INTO build_info (sha, build) VALUES (?, ?)').run(SHA, 142);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const info = await getBuildInfo();

    expect(info).toEqual({ build: 142, sha: SHA });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns build null and caches nothing when fetch rejects', async () => {
    vi.stubEnv('RAILWAY_GIT_COMMIT_SHA', SHA);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const info = await getBuildInfo();

    expect(info).toEqual({ build: null, sha: SHA });
    expect(
      getDatabase().prepare('SELECT build FROM build_info WHERE sha = ?').get(SHA),
    ).toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('returns build null on a non-2xx response', async () => {
    vi.stubEnv('RAILWAY_GIT_COMMIT_SHA', SHA);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, headers: new Headers() }));

    const info = await getBuildInfo();

    expect(info).toEqual({ build: null, sha: SHA });
    expect(logger.warn).toHaveBeenCalled();
  });

  it('returns build null when the Link header is missing', async () => {
    vi.stubEnv('RAILWAY_GIT_COMMIT_SHA', SHA);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(null)));

    const info = await getBuildInfo();

    expect(info).toEqual({ build: null, sha: SHA });
    expect(
      getDatabase().prepare('SELECT build FROM build_info WHERE sha = ?').get(SHA),
    ).toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('getBuildInfo — local dev fallback', () => {
  it('derives build and sha from local git when the Railway env var is unset', async () => {
    vi.stubEnv('RAILWAY_GIT_COMMIT_SHA', '');
    // No fetch stub: the local path must not touch the network.

    const info = await getBuildInfo();

    // This test runs inside the repo (locally and in CI checkout), so git is
    // available: a positive count and a non-empty short SHA.
    expect(info.build).toBeGreaterThan(0);
    expect(info.sha).toBeTruthy();
  });
});

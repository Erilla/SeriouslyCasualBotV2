import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../src/database/db.js';
import {
  getCachedOrFetch,
  getIconOrFetch,
  flushCache,
  FOREVER,
  ttl,
} from '../../src/services/apiCache.js';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  initDatabase(':memory:');
});

afterEach(() => {
  closeDatabase();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('getCachedOrFetch', () => {
  it('calls the fetcher on a miss and stores the result', async () => {
    const fetcher = vi.fn().mockResolvedValue({ hello: 'world' });
    const result = await getCachedOrFetch('k1', FOREVER, fetcher);
    expect(result).toEqual({ hello: 'world' });
    expect(fetcher).toHaveBeenCalledTimes(1);

    const row = getDatabase().prepare('SELECT payload FROM api_cache WHERE key = ?').get('k1') as
      | { payload: string }
      | undefined;
    expect(row).toBeDefined();
    expect(JSON.parse(row!.payload)).toEqual({ hello: 'world' });
  });

  it('returns the cached value without calling the fetcher when fresh', async () => {
    await getCachedOrFetch('k1', FOREVER, () => Promise.resolve({ v: 1 }));
    const fetcher = vi.fn().mockResolvedValue({ v: 2 });
    const result = await getCachedOrFetch('k1', FOREVER, fetcher);
    expect(result).toEqual({ v: 1 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('refetches when the freshness predicate rejects the entry', async () => {
    await getCachedOrFetch('k1', FOREVER, () => Promise.resolve({ v: 1 }));
    const fetcher = vi.fn().mockResolvedValue({ v: 2 });
    const never = () => false;
    const result = await getCachedOrFetch('k1', never, fetcher);
    expect(result).toEqual({ v: 2 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    // And the stored entry was replaced.
    const again = await getCachedOrFetch('k1', FOREVER, () => Promise.resolve({ v: 3 }));
    expect(again).toEqual({ v: 2 });
  });

  it('ttl() accepts entries younger than the window and rejects older ones', () => {
    const sevenDays = ttl(7 * 24 * 60 * 60 * 1000);
    const now = Date.now();
    expect(sevenDays(null, new Date(now - 1000))).toBe(true);
    expect(sevenDays(null, new Date(now - 8 * 24 * 60 * 60 * 1000))).toBe(false);
  });

  it('propagates fetcher errors and caches nothing', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(getCachedOrFetch('k1', FOREVER, fetcher)).rejects.toThrow('boom');
    const row = getDatabase().prepare('SELECT * FROM api_cache WHERE key = ?').get('k1');
    expect(row).toBeUndefined();
  });
});

describe('getIconOrFetch', () => {
  it('downloads on miss, stores the blob, and serves from cache after', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => bytes.buffer,
    });
    globalThis.fetch = fetchMock;

    const first = await getIconOrFetch('test_icon', 'https://example.test/test_icon.jpg');
    expect(Buffer.compare(first, Buffer.from(bytes))).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const second = await getIconOrFetch('test_icon', 'https://example.test/test_icon.jpg');
    expect(Buffer.compare(second, Buffer.from(bytes))).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws on a non-OK response and caches nothing', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    await expect(getIconOrFetch('missing', 'https://example.test/missing.jpg')).rejects.toThrow(
      'missing',
    );
    const row = getDatabase().prepare('SELECT * FROM icon_cache WHERE name = ?').get('missing');
    expect(row).toBeUndefined();
  });
});

describe('flushCache', () => {
  it('empties both cache tables', async () => {
    await getCachedOrFetch('k1', FOREVER, () => Promise.resolve({ v: 1 }));
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([9]).buffer,
    });
    await getIconOrFetch('icon1', 'https://example.test/icon1.jpg');

    flushCache();

    const db = getDatabase();
    expect(db.prepare('SELECT COUNT(*) AS n FROM api_cache').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM icon_cache').get()).toEqual({ n: 0 });
  });
});

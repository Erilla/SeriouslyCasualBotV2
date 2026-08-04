import { getDatabase } from '../database/db.js';

/**
 * SQLite-backed cache for the achievements image pipeline: JSON payloads in
 * api_cache, downloaded icon images in icon_cache. Freshness is decided by
 * the caller via a predicate so immutable data ("forever") and TTL'd data
 * share one code path. Any fetch error propagates — callers are fail-fast.
 */

interface ApiCacheRow {
  payload: string;
  fetched_at: string;
}

/** Freshness predicate: entry is valid forever. */
export const FOREVER = (_value: unknown, _fetchedAt: Date): boolean => true;

/** Freshness predicate: entry is valid for `ms` after it was fetched. */
export function ttl(ms: number): (value: unknown, fetchedAt: Date) => boolean {
  return (_value, fetchedAt) => Date.now() - fetchedAt.getTime() < ms;
}

export async function getCachedOrFetch<T>(
  key: string,
  isFresh: (value: T, fetchedAt: Date) => boolean,
  fetcher: () => Promise<T>,
): Promise<T> {
  const db = getDatabase();
  const row = db.prepare('SELECT payload, fetched_at FROM api_cache WHERE key = ?').get(key) as
    | ApiCacheRow
    | undefined;

  if (row) {
    const value = JSON.parse(row.payload) as T;
    if (isFresh(value, new Date(row.fetched_at))) return value;
  }

  const value = await fetcher();
  db.prepare('INSERT OR REPLACE INTO api_cache (key, payload, fetched_at) VALUES (?, ?, ?)').run(
    key,
    JSON.stringify(value),
    new Date().toISOString(),
  );
  return value;
}

export async function getIconOrFetch(name: string, url: string): Promise<Buffer> {
  const db = getDatabase();
  const row = db.prepare('SELECT image FROM icon_cache WHERE name = ?').get(name) as
    | { image: Buffer }
    | undefined;
  if (row) return row.image;

  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new Error(`Icon download failed for ${name}: ${response.status} (${url})`);
  }
  const image = Buffer.from(await response.arrayBuffer());
  db.prepare('INSERT OR REPLACE INTO icon_cache (name, image, fetched_at) VALUES (?, ?, ?)').run(
    name,
    image,
    new Date().toISOString(),
  );
  return image;
}

export function flushCache(): void {
  const db = getDatabase();
  db.prepare('DELETE FROM api_cache').run();
  db.prepare('DELETE FROM icon_cache').run();
}

/**
 * Delete cache entries under `prefix` older than `olderThanMs`, returning the
 * number removed. Prefix-scoped so pruning bulky fingerprints cannot evict the
 * achievements-image entries, which are FOREVER by design.
 */
/** Total rows in api_cache — logged next to a prune so volume growth is
 *  observable in production rather than only visible once the disk is full. */
export function cacheRowCount(): number {
  const db = getDatabase();
  const row = db.prepare('SELECT COUNT(*) AS n FROM api_cache').get() as { n: number };
  return row.n;
}

export function pruneCache(prefix: string, olderThanMs: number): number {
  const db = getDatabase();
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const result = db
    .prepare("DELETE FROM api_cache WHERE key LIKE ? || '%' AND fetched_at < ?")
    .run(prefix, cutoff);
  return result.changes;
}

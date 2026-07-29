# Achievements Image v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the achievements image around Raider.IO's parameterised guild-profile and live-tracking endpoints (~35 API calls → ~3–4), enrich it with raid/boss/expansion icons, add a per-boss live breakdown for in-progress raids, and cache immutable data in SQLite with `/updateachievements flush:true` as the escape hatch.

**Architecture:** Split the monolithic `updateAchievements.ts` into `achievementsData.ts` (fetch + merge + CE → plain model), `achievementsRender.ts` (model → PNG), and a slim orchestrator. New generic `apiCache.ts` service backs the cache tables added in schema migration v9. Fail-fast: any fetch error aborts the whole update.

**Tech Stack:** TypeScript (Node16 ESM, `.js` import suffixes), discord.js v14, better-sqlite3, @napi-rs/canvas, vitest.

**Spec:** `docs/superpowers/specs/2026-07-29-achievements-image-v2-design.md`

## Global Constraints

- Fail-fast: any error (API call, icon fetch) aborts the entire update; never post a partial image.
- Never cache guild-profile summary calls or live `raid-progress`.
- Icons fetched from `https://wow.zamimg.com/images/wow/icons/large/{name}.jpg` (handles both icon names and numeric FileDataIDs).
- `getRaidRankings` and `RAIDERIO_GUILD_IDS` must keep working (quipContext uses them).
- Existing message-edit/post flow in `updateAchievements` is unchanged.
- Run `npm run format:check` before every push — CI fails on prettier drift (use `npm run format` to fix).
- Commit messages end with the Claude co-author footer (see repo memory); use `git commit -F -` with a heredoc from Git Bash, never PowerShell here-strings.

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `src/database/schema.ts` | Modify | Add `api_cache`, `icon_cache` tables; `icon` column on `achievements_manual` |
| `src/database/db.ts` | Modify | Migration v9 (tables + column + manual-icon backfill) |
| `src/database/seed.ts` | Modify | Seed manual achievements with icons |
| `src/types/index.ts` | Modify | `AchievementsManualRow.icon` |
| `src/services/apiCache.ts` | Create | SQLite-backed JSON + icon cache, flush |
| `src/config.ts` | Modify | `raiderIoGuilds` identity list |
| `.env.example` | Modify | Document optional `RAIDERIO_GUILDS` override |
| `src/services/raiderio.ts` | Modify | `getGuildRaidSummary`, `getGuildRaidEncounters`, `getLiveRaidProgress`; extend static-data type |
| `src/functions/guild-info/achievementsData.ts` | Create | Fetch, merge identities, CE logic, icon resolution → `AchievementsModel` |
| `src/functions/guild-info/achievementsRender.ts` | Create | `AchievementsModel` → PNG buffer |
| `src/functions/guild-info/updateAchievements.ts` | Modify | Slim orchestration + Discord posting only |
| `src/commands/updateachievements.ts` | Modify | Optional `flush` boolean |
| `docs/commands.md` | Modify | Document `flush` option |

---

### Task 1: Schema migration v9 — cache tables, manual icon column

**Files:**
- Modify: `src/database/schema.ts`
- Modify: `src/database/db.ts`
- Modify: `src/database/seed.ts:92-110`
- Modify: `src/types/index.ts:173-180`
- Test: `tests/integration/database-schema.test.ts`

**Interfaces:**
- Consumes: existing `createTables`/`runMigrations` pattern (v8 is the latest applied version).
- Produces: tables `api_cache(key TEXT PK, payload TEXT NOT NULL, fetched_at TEXT NOT NULL)` and `icon_cache(name TEXT PK, image BLOB NOT NULL, fetched_at TEXT NOT NULL)`; column `achievements_manual.icon TEXT`; `AchievementsManualRow.icon: string | null`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/integration/database-schema.test.ts` (follow the file's existing `initDatabase(':memory:')` + `closeDatabase()` pattern — check its `beforeEach`/`afterEach` before adding):

```ts
describe('schema v9 — achievements cache', () => {
  it('creates api_cache and icon_cache tables', () => {
    initDatabase(':memory:');
    const db = getDatabase();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('api_cache', 'icon_cache')")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name).sort()).toEqual(['api_cache', 'icon_cache']);
  });

  it('achievements_manual has an icon column, seeded for the four manual rows', () => {
    initDatabase(':memory:');
    const db = getDatabase();
    const cols = db.pragma('table_info(achievements_manual)') as { name: string }[];
    expect(cols.some((c) => c.name === 'icon')).toBe(true);

    const rows = db
      .prepare('SELECT raid, icon FROM achievements_manual ORDER BY expansion, sort_order')
      .all() as { raid: string; icon: string | null }[];
    expect(rows).toEqual([
      { raid: 'Siege of Orgrimmar (10 man)', icon: 'achievement_boss_garrosh' },
      { raid: 'Highmaul', icon: 'achievement_boss_highmaul_king' },
      { raid: 'Blackrock Foundry', icon: 'achievement_boss_blackhand' },
      { raid: 'Hellfire Citadel', icon: 'achievement_boss_hellfire_archimonde' },
    ]);
  });

  it('migration v9 is idempotent on a database that already ran it', () => {
    initDatabase(':memory:');
    const db = getDatabase();
    expect(() => runMigrations(db)).not.toThrow();
  });
});
```

Add `runMigrations` to the file's existing import from `../../src/database/db.js` if not already imported.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:integration -- database-schema`
Expected: FAIL — `api_cache`/`icon_cache` missing, `icon` column missing.

- [ ] **Step 3: Implement schema + migration + seed + type**

`src/database/schema.ts` — extend the `achievements_manual` definition and add two tables at the end of the `db.exec` block (before the closing backtick):

```sql
    -- 22. achievements_manual
    CREATE TABLE IF NOT EXISTS achievements_manual (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      raid TEXT NOT NULL,
      progress TEXT NOT NULL,
      result TEXT NOT NULL,
      expansion INTEGER NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      icon TEXT
    );
```

```sql
    -- 26. api_cache (Raider.IO response cache for the achievements image)
    CREATE TABLE IF NOT EXISTS api_cache (
      key TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    );

    -- 27. icon_cache (WoW icon images fetched from zamimg)
    CREATE TABLE IF NOT EXISTS icon_cache (
      name TEXT PRIMARY KEY,
      image BLOB NOT NULL,
      fetched_at TEXT NOT NULL
    );
```

`src/database/db.ts` — append after the `currentVersion < 8` block, following the same pattern:

```ts
  if (currentVersion < 9) {
    // Achievements image v2: cache tables for Raider.IO payloads + zamimg
    // icons, plus a per-row icon on the manual achievements. Fresh DBs get
    // the tables/column from createTables; the guards keep this idempotent.
    database.transaction(() => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS api_cache (
          key TEXT PRIMARY KEY,
          payload TEXT NOT NULL,
          fetched_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS icon_cache (
          name TEXT PRIMARY KEY,
          image BLOB NOT NULL,
          fetched_at TEXT NOT NULL
        );
      `);
      const cols = database.pragma('table_info(achievements_manual)') as { name: string }[];
      if (!cols.some((c) => c.name === 'icon')) {
        database.exec('ALTER TABLE achievements_manual ADD COLUMN icon TEXT');
      }
      // Backfill icons for the known manual rows (no-op if renamed/absent).
      const setIcon = database.prepare(
        'UPDATE achievements_manual SET icon = ? WHERE raid = ? AND icon IS NULL',
      );
      setIcon.run('achievement_boss_garrosh', 'Siege of Orgrimmar (10 man)');
      setIcon.run('achievement_boss_highmaul_king', 'Highmaul');
      setIcon.run('achievement_boss_blackhand', 'Blackrock Foundry');
      setIcon.run('achievement_boss_hellfire_archimonde', 'Hellfire Citadel');
      database.prepare('INSERT INTO schema_version (version) VALUES (?)').run(9);
    })();
  }
```

`src/database/seed.ts` — add `icon` to the manual achievements array and INSERT:

```ts
    const achievements = [
      {
        raid: 'Siege of Orgrimmar (10 man)',
        progress: '14/14HC',
        result: '**CE** WR 1997',
        expansion: 4,
        sort: 1,
        icon: 'achievement_boss_garrosh',
      },
      {
        raid: 'Highmaul',
        progress: '7/7M',
        result: '**CE** WR 1252',
        expansion: 5,
        sort: 1,
        icon: 'achievement_boss_highmaul_king',
      },
      {
        raid: 'Blackrock Foundry',
        progress: '8/10M',
        result: 'WR 1132',
        expansion: 5,
        sort: 2,
        icon: 'achievement_boss_blackhand',
      },
      {
        raid: 'Hellfire Citadel',
        progress: '13/13M',
        result: '**CE** WR 1170',
        expansion: 5,
        sort: 3,
        icon: 'achievement_boss_hellfire_archimonde',
      },
    ];

    for (const a of achievements) {
      db.prepare(
        'INSERT INTO achievements_manual (raid, progress, result, expansion, sort_order, icon) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(a.raid, a.progress, a.result, a.expansion, a.sort, a.icon);
    }
```

`src/types/index.ts` — extend the row type:

```ts
export interface AchievementsManualRow {
  id: number;
  raid: string;
  progress: string;
  result: string;
  expansion: number;
  sort_order: number;
  icon: string | null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:integration -- database-schema`
Expected: PASS (all, including pre-existing tests).

- [ ] **Step 5: Commit**

```bash
git add src/database/schema.ts src/database/db.ts src/database/seed.ts src/types/index.ts tests/integration/database-schema.test.ts
git commit -m "feat(db): schema v9 - api/icon cache tables, manual achievement icons"
```

---

### Task 2: apiCache service

**Files:**
- Create: `src/services/apiCache.ts`
- Test: `tests/unit/apiCache.test.ts`

**Interfaces:**
- Consumes: `getDatabase()` from `src/database/db.js`; tables from Task 1.
- Produces (exact exports used by Tasks 5–7):
  - `getCachedOrFetch<T>(key: string, isFresh: (value: T, fetchedAt: Date) => boolean, fetcher: () => Promise<T>): Promise<T>`
  - `FOREVER: (value: unknown, fetchedAt: Date) => boolean` (always true)
  - `ttl(ms: number): (value: unknown, fetchedAt: Date) => boolean`
  - `getIconOrFetch(name: string, url: string): Promise<Buffer>`
  - `flushCache(): void`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/apiCache.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- apiCache`
Expected: FAIL with "Cannot find module .../apiCache.js".

- [ ] **Step 3: Implement**

Create `src/services/apiCache.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- apiCache`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/apiCache.ts tests/unit/apiCache.test.ts
git commit -m "feat: apiCache service - SQLite JSON/icon cache with flush"
```

---

### Task 3: Guild identities in config

**Files:**
- Modify: `src/config.ts`
- Modify: `.env.example`
- Test: `tests/unit/config.test.ts`

**Interfaces:**
- Produces: `config.raiderIoGuilds: Array<{ region: string; realm: string; name: string }>` — defaults to the Silvermoon + Darksorrow identities; overridable via `RAIDERIO_GUILDS` env (JSON). `RAIDERIO_GUILD_IDS` is untouched.

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe('config', …)` in `tests/unit/config.test.ts` (reuse the full stub list from the "valid config" test):

```ts
  it('parses raiderIoGuilds with the built-in default identities', async () => {
    vi.stubEnv('DISCORD_TOKEN', 'test-token');
    vi.stubEnv('CLIENT_ID', 'test-client');
    vi.stubEnv('GUILD_ID', 'test-guild');
    vi.stubEnv('OFFICER_ROLE_ID', 'test-role');
    vi.stubEnv('WOWAUDIT_API_SECRET', 'test-secret');
    vi.stubEnv('WARCRAFTLOGS_CLIENT_ID', 'test-wcl-id');
    vi.stubEnv('WARCRAFTLOGS_CLIENT_SECRET', 'test-wcl-secret');
    vi.stubEnv('WARCRAFTLOGS_GUILD_ID', '486913');
    vi.stubEnv('RAIDERIO_GUILD_IDS', '123%2C456');

    const { config } = await import('../../src/config.js');

    expect(config.raiderIoGuilds).toEqual([
      { region: 'eu', realm: 'silvermoon', name: 'seriouslycasual' },
      { region: 'eu', realm: 'darksorrow', name: 'seriously casual' },
    ]);
  });

  it('honours a RAIDERIO_GUILDS env override', async () => {
    vi.stubEnv('DISCORD_TOKEN', 'test-token');
    vi.stubEnv('CLIENT_ID', 'test-client');
    vi.stubEnv('GUILD_ID', 'test-guild');
    vi.stubEnv('OFFICER_ROLE_ID', 'test-role');
    vi.stubEnv('WOWAUDIT_API_SECRET', 'test-secret');
    vi.stubEnv('WARCRAFTLOGS_CLIENT_ID', 'test-wcl-id');
    vi.stubEnv('WARCRAFTLOGS_CLIENT_SECRET', 'test-wcl-secret');
    vi.stubEnv('WARCRAFTLOGS_GUILD_ID', '486913');
    vi.stubEnv('RAIDERIO_GUILD_IDS', '123%2C456');
    vi.stubEnv('RAIDERIO_GUILDS', '[{"region":"us","realm":"illidan","name":"other"}]');

    const { config } = await import('../../src/config.js');

    expect(config.raiderIoGuilds).toEqual([{ region: 'us', realm: 'illidan', name: 'other' }]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- config`
Expected: FAIL — `raiderIoGuilds` is undefined.

- [ ] **Step 3: Implement**

`src/config.ts` — add above the `config` export:

```ts
export interface RaiderIoGuildIdentity {
  region: string;
  realm: string;
  name: string;
}

// The guild's Raider.IO identities: current (Silvermoon, Shadowlands onward)
// and pre-transfer (Darksorrow, Legion/BfA era). Overridable via the
// RAIDERIO_GUILDS env var (JSON array of {region, realm, name}).
const DEFAULT_RAIDERIO_GUILDS =
  '[{"region":"eu","realm":"silvermoon","name":"seriouslycasual"},' +
  '{"region":"eu","realm":"darksorrow","name":"seriously casual"}]';
```

and inside the `config` object, after `raiderIoGuildIds`:

```ts
  raiderIoGuilds: JSON.parse(
    optional('RAIDERIO_GUILDS', DEFAULT_RAIDERIO_GUILDS),
  ) as RaiderIoGuildIdentity[],
```

`.env.example` — add under the `RAIDERIO_GUILD_IDS` line:

```
# Optional: override the guild identities used for the achievements image.
# JSON array of {region, realm, name}; defaults to Silvermoon + Darksorrow.
# RAIDERIO_GUILDS=[{"region":"eu","realm":"silvermoon","name":"seriouslycasual"}]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- config`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts .env.example tests/unit/config.test.ts
git commit -m "feat(config): raiderIoGuilds identity list with env override"
```

---

### Task 4: New Raider.IO endpoint functions

**Files:**
- Modify: `src/services/raiderio.ts`
- Test: `tests/unit/raiderio.test.ts`

**Interfaces:**
- Consumes: existing `httpRequest('raiderio', url)` and `BASE_URL`.
- Produces (exact exports used by Task 6):

```ts
export interface GuildIdentity { region: string; realm: string; name: string }
export interface RaidProgressionEntry {
  summary: string;
  total_bosses: number;
  mythic_bosses_killed: number;
}
export interface RaidRankingRanks { world: number; region: number; realm: number }
export interface GuildRaidSummary {
  raid_progression: Record<string, RaidProgressionEntry>;
  raid_rankings: Record<string, { mythic: RaidRankingRanks }>;
}
export interface RaidEncounterKill { slug: string; name: string; defeatedAt: string }
export interface LiveBossProgress {
  boss: { name: string; slug: string; ordinal: number; iconUrl: string | null };
  pullCount: number;
  bestPercent: number;
  isDefeated: boolean | number; // API returns 1 for kills, false for alive
}
getGuildRaidSummary(identity: GuildIdentity, expansionIds: number[]): Promise<GuildRaidSummary>
getGuildRaidEncounters(identity: GuildIdentity, raidSlug: string): Promise<RaidEncounterKill[]>
getLiveRaidProgress(identity: GuildIdentity, raidSlug: string): Promise<LiveBossProgress[]>
```

- Also extends `RaidStaticData` raids with `short_name?: string` and `icon?: string`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/raiderio.test.ts` (imports: add `getGuildRaidSummary`, `getGuildRaidEncounters`, `getLiveRaidProgress` to the existing import from `raiderio.js`):

```ts
const identity = { region: 'eu', realm: 'silvermoon', name: 'seriouslycasual' };

describe('getGuildRaidSummary', () => {
  it('requests parameterised raid_progression and raid_rankings fields', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: async () => ({ raid_progression: {}, raid_rankings: {} }),
    });

    await getGuildRaidSummary(identity, [6, 7, 10]);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://raider.io/api/v1/guilds/profile?region=eu&realm=silvermoon&name=seriouslycasual' +
        '&fields=raid_progression%3A6%3A7%3A10%2Craid_rankings%3A6%3A7%3A10',
      expect.any(Object),
    );
  });

  it('defaults missing sections to empty objects', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: async () => ({ name: 'SeriouslyCasual' }),
    });

    const result = await getGuildRaidSummary(identity, [10]);
    expect(result).toEqual({ raid_progression: {}, raid_rankings: {} });
  });

  it('URL-encodes identities with spaces', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: async () => ({ raid_progression: {}, raid_rankings: {} }),
    });

    await getGuildRaidSummary({ region: 'eu', realm: 'darksorrow', name: 'seriously casual' }, [6]);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('name=seriously%20casual'),
      expect.any(Object),
    );
  });
});

describe('getGuildRaidEncounters', () => {
  it('requests the raid_encounters field for the raid at mythic', async () => {
    const kills = [{ slug: 'queen-ansurek', name: 'Queen Ansurek', defeatedAt: '2025-02-12T20:37:04.000Z' }];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: async () => ({ raid_encounters: kills }),
    });

    const result = await getGuildRaidEncounters(identity, 'nerubar-palace');

    expect(result).toEqual(kills);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('fields=raid_encounters%3Anerubar-palace%3Amythic'),
      expect.any(Object),
    );
  });

  it('returns [] when the field is absent', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: async () => ({}),
    });
    expect(await getGuildRaidEncounters(identity, 'nerubar-palace')).toEqual([]);
  });
});

describe('getLiveRaidProgress', () => {
  it('requests live raid progress with period=until_kill and returns bosses', async () => {
    const bosses = [
      {
        boss: { name: 'Midnight Falls', slug: 'midnight-falls', ordinal: 8, iconUrl: '/images/wow/icons/large/foo.jpg' },
        pullCount: 199,
        bestPercent: 67.24,
        isDefeated: false,
      },
    ];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: async () => ({ bosses }),
    });

    const result = await getLiveRaidProgress(identity, 'tier-mn-1');

    expect(result).toEqual(bosses);
    const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain('/live-tracking/guild/raid-progress?');
    expect(url).toContain('raid=tier-mn-1');
    expect(url).toContain('difficulty=mythic');
    expect(url).toContain('period=until_kill');
    expect(url).toContain('guild=seriouslycasual');
  });

  it('returns [] when the response has no bosses', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: async () => ({}),
    });
    expect(await getLiveRaidProgress(identity, 'tier-mn-1')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- raiderio`
Expected: FAIL — new functions not exported.

- [ ] **Step 3: Implement**

In `src/services/raiderio.ts`, extend the static-data raid shape (add to the existing `RaidStaticData` raids array element type):

```ts
    short_name?: string;
    icon?: string;
```

Append the new types and functions:

```ts
export interface GuildIdentity {
  region: string;
  realm: string;
  name: string;
}

export interface RaidProgressionEntry {
  summary: string;
  total_bosses: number;
  mythic_bosses_killed: number;
}

export interface RaidRankingRanks {
  world: number;
  region: number;
  realm: number;
}

export interface GuildRaidSummary {
  raid_progression: Record<string, RaidProgressionEntry>;
  raid_rankings: Record<string, { mythic: RaidRankingRanks }>;
}

export interface RaidEncounterKill {
  slug: string;
  name: string;
  defeatedAt: string;
}

export interface LiveBossProgress {
  boss: {
    name: string;
    slug: string;
    ordinal: number;
    iconUrl: string | null;
  };
  pullCount: number;
  bestPercent: number;
  // The live API returns 1 for defeated bosses and false for alive ones.
  isDefeated: boolean | number;
}

function identityParams(identity: GuildIdentity): string {
  return `region=${identity.region}&realm=${encodeURIComponent(identity.realm)}&name=${encodeURIComponent(identity.name)}`;
}

/** Progression + mythic rankings for every raid of the given expansions, one call. */
export async function getGuildRaidSummary(
  identity: GuildIdentity,
  expansionIds: number[],
): Promise<GuildRaidSummary> {
  const params = expansionIds.join(':');
  const fields = encodeURIComponent(`raid_progression:${params},raid_rankings:${params}`);
  const url = `${BASE_URL}/guilds/profile?${identityParams(identity)}&fields=${fields}`;
  const data = await httpRequest<Partial<GuildRaidSummary>>('raiderio', url);
  return {
    raid_progression: data.raid_progression ?? {},
    raid_rankings: data.raid_rankings ?? {},
  };
}

/** Per-boss mythic first-kill timestamps for one raid. */
export async function getGuildRaidEncounters(
  identity: GuildIdentity,
  raidSlug: string,
): Promise<RaidEncounterKill[]> {
  const fields = encodeURIComponent(`raid_encounters:${raidSlug}:mythic`);
  const url = `${BASE_URL}/guilds/profile?${identityParams(identity)}&fields=${fields}`;
  const data = await httpRequest<{ raid_encounters?: RaidEncounterKill[] }>('raiderio', url);
  return data.raid_encounters ?? [];
}

/**
 * Live per-boss pull counts / best % for one raid (mythic, pulls until first
 * kill). Note the live-tracking endpoint names its guild parameter `guild`,
 * not `name`, so it can't reuse identityParams().
 */
export async function getLiveRaidProgress(
  identity: GuildIdentity,
  raidSlug: string,
): Promise<LiveBossProgress[]> {
  const url =
    `${BASE_URL}/live-tracking/guild/raid-progress?raid=${raidSlug}&difficulty=mythic` +
    `&region=${identity.region}&realm=${encodeURIComponent(identity.realm)}` +
    `&guild=${encodeURIComponent(identity.name)}&period=until_kill`;
  const data = await httpRequest<{ bosses?: LiveBossProgress[] }>('raiderio', url);
  return data.bosses ?? [];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- raiderio`
Expected: PASS (new and pre-existing tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/raiderio.ts tests/unit/raiderio.test.ts
git commit -m "feat(raiderio): guild raid summary, encounters, live progress endpoints"
```

---

### Task 5: achievementsData — pure logic (merge, CE, freshness, icons)

**Files:**
- Create: `src/functions/guild-info/achievementsData.ts` (pure helpers only; `buildAchievementsModel` comes in Task 6)
- Test: `tests/unit/achievementsData.test.ts`

**Interfaces:**
- Consumes: types from Task 4 (`GuildIdentity`, `GuildRaidSummary`).
- Produces (exact exports; Task 6 adds `buildAchievementsModel` to this same file):

```ts
export interface MergedStanding {
  identity: GuildIdentity;
  mythicKilled: number;
  totalBosses: number;
  worldRank: number; // 0 = unranked
}
export function mergeGuildSummaries(
  summaries: Array<{ identity: GuildIdentity; summary: GuildRaidSummary }>,
): Map<string, MergedStanding>
export function determineCE(args: {
  mythicKilled: number;
  totalBosses: number;
  tierEndsEu: string | null;
  lastBossDefeatedAt: string | null;
}): boolean
export function staticDataFreshness(value: RaidStaticData, fetchedAt: Date): boolean
export function expansionIconName(expansionId: number, newestRaidIcon: string | null): string | null
export function zamimgUrl(iconName: string): string
export function iconNameFromUrl(iconUrl: string): string | null
export const EXPANSION_NAMES: Record<number, string>
```

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/achievementsData.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  mergeGuildSummaries,
  determineCE,
  staticDataFreshness,
  expansionIconName,
  zamimgUrl,
  iconNameFromUrl,
} from '../../src/functions/guild-info/achievementsData.js';
import type { RaidStaticData } from '../../src/services/raiderio.js';

const silvermoon = { region: 'eu', realm: 'silvermoon', name: 'seriouslycasual' };
const darksorrow = { region: 'eu', realm: 'darksorrow', name: 'seriously casual' };

function summaryFor(raids: Record<string, { killed: number; total: number; world: number }>) {
  const raid_progression: Record<string, { summary: string; total_bosses: number; mythic_bosses_killed: number }> = {};
  const raid_rankings: Record<string, { mythic: { world: number; region: number; realm: number } }> = {};
  for (const [slug, r] of Object.entries(raids)) {
    raid_progression[slug] = {
      summary: `${r.killed}/${r.total} M`,
      total_bosses: r.total,
      mythic_bosses_killed: r.killed,
    };
    raid_rankings[slug] = { mythic: { world: r.world, region: 0, realm: 0 } };
  }
  return { raid_progression, raid_rankings };
}

describe('mergeGuildSummaries', () => {
  it('takes the identity with more mythic kills per raid', () => {
    const merged = mergeGuildSummaries([
      { identity: silvermoon, summary: summaryFor({ 'raid-a': { killed: 3, total: 8, world: 900 } }) },
      { identity: darksorrow, summary: summaryFor({ 'raid-a': { killed: 8, total: 8, world: 1200 } }) },
    ]);
    expect(merged.get('raid-a')).toEqual({
      identity: darksorrow,
      mythicKilled: 8,
      totalBosses: 8,
      worldRank: 1200,
    });
  });

  it('breaks kill ties on better non-zero world rank', () => {
    const merged = mergeGuildSummaries([
      { identity: silvermoon, summary: summaryFor({ 'raid-a': { killed: 8, total: 8, world: 0 } }) },
      { identity: darksorrow, summary: summaryFor({ 'raid-a': { killed: 8, total: 8, world: 1200 } }) },
    ]);
    expect(merged.get('raid-a')!.identity).toEqual(darksorrow);
    expect(merged.get('raid-a')!.worldRank).toBe(1200);
  });

  it('unions raids that exist under only one identity', () => {
    const merged = mergeGuildSummaries([
      { identity: silvermoon, summary: summaryFor({ 'raid-new': { killed: 5, total: 8, world: 2000 } }) },
      { identity: darksorrow, summary: summaryFor({ 'raid-old': { killed: 7, total: 7, world: 800 } }) },
    ]);
    expect(merged.get('raid-new')!.identity).toEqual(silvermoon);
    expect(merged.get('raid-old')!.identity).toEqual(darksorrow);
  });
});

describe('determineCE', () => {
  it('is false when not all bosses are killed', () => {
    expect(
      determineCE({ mythicKilled: 7, totalBosses: 8, tierEndsEu: null, lastBossDefeatedAt: null }),
    ).toBe(false);
  });

  it('is true for a full clear in an ongoing tier (end date in the future)', () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect(
      determineCE({ mythicKilled: 8, totalBosses: 8, tierEndsEu: future, lastBossDefeatedAt: null }),
    ).toBe(true);
  });

  it('is true when the last boss died before the tier ended', () => {
    expect(
      determineCE({
        mythicKilled: 8,
        totalBosses: 8,
        tierEndsEu: '2025-03-05T04:00:00Z',
        lastBossDefeatedAt: '2025-02-12T20:37:04Z',
      }),
    ).toBe(true);
  });

  it('is false when the last boss died after the tier ended', () => {
    expect(
      determineCE({
        mythicKilled: 8,
        totalBosses: 8,
        tierEndsEu: '2025-03-05T04:00:00Z',
        lastBossDefeatedAt: '2025-04-01T20:00:00Z',
      }),
    ).toBe(false);
  });

  it('assumes CE when the kill timestamp is unavailable (matches current behaviour)', () => {
    expect(
      determineCE({
        mythicKilled: 8,
        totalBosses: 8,
        tierEndsEu: '2025-03-05T04:00:00Z',
        lastBossDefeatedAt: null,
      }),
    ).toBe(true);
  });
});

describe('staticDataFreshness', () => {
  const past = '2020-01-01T00:00:00Z';
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const raid = (endsEu: string | null) =>
    ({ id: 1, slug: 's', name: 'n', expansion_id: 6, starts: { us: null, eu: null }, ends: { us: null, eu: endsEu }, encounters: [] });

  it('never treats an empty expansion as fresh', () => {
    expect(staticDataFreshness({ raids: [] } as RaidStaticData, new Date())).toBe(false);
  });

  it('treats a fully-ended expansion as fresh forever', () => {
    const old = new Date('2020-06-01T00:00:00Z');
    expect(staticDataFreshness({ raids: [raid(past)] } as RaidStaticData, old)).toBe(true);
  });

  it('treats an open expansion as fresh only within 7 days', () => {
    const data = { raids: [raid(future)] } as RaidStaticData;
    expect(staticDataFreshness(data, new Date())).toBe(true);
    expect(staticDataFreshness(data, new Date(Date.now() - 8 * 86_400_000))).toBe(false);
  });
});

describe('icon helpers', () => {
  it('maps known expansions and falls back to the newest raid icon', () => {
    expect(expansionIconName(4, null)).toBe('expansionicon_mistsofpandaria');
    expect(expansionIconName(8, 'ignored')).toBe('inv_progenitor_runevessel');
    expect(expansionIconName(10, 'inv_112_achievement_raid_manaforgeomega')).toBe(
      'inv_112_achievement_raid_manaforgeomega',
    );
    expect(expansionIconName(10, null)).toBeNull();
  });

  it('builds zamimg URLs and extracts names from raider.io iconUrl paths', () => {
    expect(zamimgUrl('achievement_boss_garrosh')).toBe(
      'https://wow.zamimg.com/images/wow/icons/large/achievement_boss_garrosh.jpg',
    );
    expect(iconNameFromUrl('/images/wow/icons/large/inv_120_raid_voidspire_kaiju.jpg')).toBe(
      'inv_120_raid_voidspire_kaiju',
    );
    expect(iconNameFromUrl('')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- achievementsData`
Expected: FAIL with "Cannot find module .../achievementsData.js".

- [ ] **Step 3: Implement the pure helpers**

Create `src/functions/guild-info/achievementsData.ts`:

```ts
import type {
  GuildIdentity,
  GuildRaidSummary,
  RaidStaticData,
} from '../../services/raiderio.js';

// ─── Expansion names (moved from updateAchievements.ts) ─────────

export const EXPANSION_NAMES: Record<number, string> = {
  1: 'Classic',
  2: 'The Burning Crusade',
  3: 'Wrath of the Lich King',
  4: 'Mists of Pandaria',
  5: 'Warlords of Draenor',
  6: 'Legion',
  7: 'Battle for Azeroth',
  8: 'Shadowlands',
  9: 'Dragonflight',
  10: 'The War Within',
  11: 'Midnight',
};

export function getExpansionName(id: number): string {
  return EXPANSION_NAMES[id] ?? `Expansion ${id}`;
}

// ─── Identity merge ─────────────────────────────────────────────

export interface MergedStanding {
  identity: GuildIdentity;
  mythicKilled: number;
  totalBosses: number;
  worldRank: number; // 0 = unranked
}

/**
 * Merge per-identity guild summaries into one standing per raid slug: the
 * identity with more mythic kills wins; kill ties go to the better non-zero
 * mythic world rank.
 */
export function mergeGuildSummaries(
  summaries: Array<{ identity: GuildIdentity; summary: GuildRaidSummary }>,
): Map<string, MergedStanding> {
  const merged = new Map<string, MergedStanding>();

  for (const { identity, summary } of summaries) {
    for (const [slug, prog] of Object.entries(summary.raid_progression)) {
      const candidate: MergedStanding = {
        identity,
        mythicKilled: prog.mythic_bosses_killed,
        totalBosses: prog.total_bosses,
        worldRank: summary.raid_rankings[slug]?.mythic.world ?? 0,
      };
      const existing = merged.get(slug);
      if (!existing || beats(candidate, existing)) merged.set(slug, candidate);
    }
  }

  return merged;
}

function beats(a: MergedStanding, b: MergedStanding): boolean {
  if (a.mythicKilled !== b.mythicKilled) return a.mythicKilled > b.mythicKilled;
  if (a.worldRank === 0) return false;
  if (b.worldRank === 0) return true;
  return a.worldRank < b.worldRank;
}

// ─── Cutting Edge ───────────────────────────────────────────────

export function determineCE(args: {
  mythicKilled: number;
  totalBosses: number;
  tierEndsEu: string | null;
  lastBossDefeatedAt: string | null;
}): boolean {
  if (args.mythicKilled < args.totalBosses) return false;
  // No end date, or the tier is still running: a full clear is CE.
  if (!args.tierEndsEu || new Date(args.tierEndsEu).getTime() > Date.now()) return true;
  // Kill timestamp unavailable: assume CE (matches previous behaviour).
  if (!args.lastBossDefeatedAt) return true;
  return new Date(args.lastBossDefeatedAt) < new Date(args.tierEndsEu);
}

// ─── Cache freshness for static data ────────────────────────────

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Static data for an expansion is immutable once every raid's EU end date is
 * in the past; while any raid is open-ended it gets a 7-day TTL. Empty
 * payloads (expansion doesn't exist yet) are never fresh.
 */
export function staticDataFreshness(value: RaidStaticData, fetchedAt: Date): boolean {
  const raids = value.raids ?? [];
  if (raids.length === 0) return false;
  const now = Date.now();
  const allEnded = raids.every((r) => r.ends.eu !== null && new Date(r.ends.eu).getTime() < now);
  if (allEnded) return true;
  return now - fetchedAt.getTime() < SEVEN_DAYS_MS;
}

// ─── Icons ──────────────────────────────────────────────────────

// Verified against zamimg (2026-07-29). Expansions absent here fall back to
// their newest raid's icon from static data.
const EXPANSION_ICONS: Record<number, string> = {
  4: 'expansionicon_mistsofpandaria',
  5: 'achievement_zone_draenor_01',
  6: 'achievement_faction_legionfall',
  7: 'inv_heartofazeroth',
  8: 'inv_progenitor_runevessel',
};

export function expansionIconName(
  expansionId: number,
  newestRaidIcon: string | null,
): string | null {
  return EXPANSION_ICONS[expansionId] ?? newestRaidIcon;
}

export function zamimgUrl(iconName: string): string {
  return `https://wow.zamimg.com/images/wow/icons/large/${iconName}.jpg`;
}

/** "/images/wow/icons/large/foo.jpg" → "foo" */
export function iconNameFromUrl(iconUrl: string): string | null {
  const base = iconUrl.split('/').pop();
  if (!base) return null;
  const name = base.replace(/\.[a-z]+$/i, '');
  return name.length > 0 ? name : null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- achievementsData`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/functions/guild-info/achievementsData.ts tests/unit/achievementsData.test.ts
git commit -m "feat(achievements): merge, CE, freshness, and icon helpers"
```

---

### Task 6: achievementsData — buildAchievementsModel

**Files:**
- Modify: `src/functions/guild-info/achievementsData.ts`
- Test: `tests/unit/achievementsData.test.ts` (extend)

**Interfaces:**
- Consumes: Task 2 cache (`getCachedOrFetch`, `FOREVER`, `getIconOrFetch`), Task 3 `config.raiderIoGuilds`, Task 4 endpoint functions, Task 1 `achievements_manual.icon`, `getDatabase()`.
- Produces (used by Task 7's renderer and Task 8's orchestrator):

```ts
export interface AchievementBossRow {
  name: string;
  icon: string | null; // icon name, key into model.icons
  pulls: number;
  bestPercent: number;
  defeated: boolean;
}
export interface AchievementRaidRow {
  raid: string;
  icon: string | null;   // icon name, key into model.icons
  progress: string;      // "8/9M" or manual text like "14/14HC"
  isCE: boolean;
  result: string;        // "WR 2281" or '' (manual rows keep their stored text)
  bosses?: AchievementBossRow[];
}
export interface AchievementsSection {
  expansionLabel: string;
  expansionIcon: string | null;
  rows: AchievementRaidRow[];
}
export interface AchievementsModel {
  sections: AchievementsSection[];
  icons: Map<string, Buffer>;
}
export async function buildAchievementsModel(): Promise<AchievementsModel>
```

(Note: the spec sketched `worldRank: number` on rows; the plan uses `result: string` so manual rows — whose stored results are free text — share the same shape. API rows set it to `WR {rank}` or `''`.)

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/achievementsData.test.ts`. These tests mock the raiderio module and use a real in-memory DB (for cache + manual rows). Place the `vi.mock` calls at the top of the file, right after the imports:

```ts
import { vi, beforeEach, afterEach } from 'vitest'; // merge into the existing vitest import
import { initDatabase, closeDatabase } from '../../src/database/db.js';
import { buildAchievementsModel } from '../../src/functions/guild-info/achievementsData.js';

const originalFetch = globalThis.fetch;

vi.mock('../../src/services/raiderio.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/raiderio.js')>();
  return {
    ...actual,
    getRaidStaticData: vi.fn(),
    getGuildRaidSummary: vi.fn(),
    getGuildRaidEncounters: vi.fn(),
    getLiveRaidProgress: vi.fn(),
  };
});

vi.mock('../../src/config.js', () => ({
  config: {
    raiderIoGuilds: [
      { region: 'eu', realm: 'silvermoon', name: 'seriouslycasual' },
      { region: 'eu', realm: 'darksorrow', name: 'seriously casual' },
    ],
    raiderIoGuildIds: 'test',
  },
}));

import {
  getRaidStaticData,
  getGuildRaidSummary,
  getGuildRaidEncounters,
  getLiveRaidProgress,
} from '../../src/services/raiderio.js';
```

Then the suite (fixture shapes mirror the real API responses captured 2026-07-29):

```ts
describe('buildAchievementsModel', () => {
  const PAST = '2020-06-01T00:00:00Z';
  const FUTURE = new Date(Date.now() + 30 * 86_400_000).toISOString();

  const legionStatic = {
    raids: [
      {
        id: 1, slug: 'the-emerald-nightmare', name: 'The Emerald Nightmare', expansion_id: 6,
        icon: 'achievement_zone_emeraldnightmare',
        starts: { us: PAST, eu: PAST }, ends: { us: PAST, eu: PAST },
        encounters: [{ id: 1, slug: 'nythendra', name: 'Nythendra' }, { id: 2, slug: 'xavius', name: 'Xavius' }],
      },
      {
        id: 2, slug: 'fated-the-emerald-nightmare', name: 'Fated The Emerald Nightmare', expansion_id: 6,
        icon: 'achievement_zone_emeraldnightmare',
        starts: { us: PAST, eu: PAST }, ends: { us: PAST, eu: PAST },
        encounters: [{ id: 1, slug: 'nythendra', name: 'Nythendra' }],
      },
    ],
  };
  const midnightStatic = {
    raids: [
      {
        id: 3, slug: 'tier-mn-1', name: 'MN Tier 1 (VS / DR / MQD)', expansion_id: 7,
        icon: 'inv_achievement_raid_darkwell',
        starts: { us: PAST, eu: PAST }, ends: { us: FUTURE, eu: FUTURE },
        encounters: [
          { id: 10, slug: 'imperator-averzian', name: 'Imperator Averzian' },
          { id: 11, slug: 'midnight-falls', name: 'Midnight Falls' },
        ],
      },
    ],
  };

  beforeEach(() => {
    initDatabase(':memory:');
    vi.mocked(getRaidStaticData).mockReset();
    vi.mocked(getGuildRaidSummary).mockReset();
    vi.mocked(getGuildRaidEncounters).mockReset();
    vi.mocked(getLiveRaidProgress).mockReset();

    // Expansions: 6 = Legion fixture, 7 = "current" Midnight fixture, 8 = empty (stop).
    vi.mocked(getRaidStaticData).mockImplementation(async (exp: number) => {
      if (exp === 6) return legionStatic as never;
      if (exp === 7) return midnightStatic as never;
      return { raids: [] } as never;
    });

    vi.mocked(getGuildRaidSummary).mockImplementation(async (identity) => {
      if (identity.realm === 'darksorrow') {
        return {
          raid_progression: {
            'the-emerald-nightmare': { summary: '2/2 M', total_bosses: 2, mythic_bosses_killed: 2 },
          },
          raid_rankings: {
            'the-emerald-nightmare': { mythic: { world: 818, region: 520, realm: 17 } },
          },
        };
      }
      return {
        raid_progression: {
          'tier-mn-1': { summary: '1/2 M', total_bosses: 2, mythic_bosses_killed: 1 },
          'fated-the-emerald-nightmare': { summary: '1/1 M', total_bosses: 1, mythic_bosses_killed: 1 },
        },
        raid_rankings: {
          'tier-mn-1': { mythic: { world: 2281, region: 1106, realm: 52 } },
          'fated-the-emerald-nightmare': { mythic: { world: 805, region: 485, realm: 15 } },
        },
      };
    });

    vi.mocked(getGuildRaidEncounters).mockResolvedValue([
      { slug: 'nythendra', name: 'Nythendra', defeatedAt: '2016-10-01T00:00:00Z' },
      { slug: 'xavius', name: 'Xavius', defeatedAt: '2016-11-01T00:00:00Z' },
    ]);

    vi.mocked(getLiveRaidProgress).mockResolvedValue([
      {
        boss: { name: 'Midnight Falls', slug: 'midnight-falls', ordinal: 1, iconUrl: '/images/wow/icons/large/boss_b.jpg' },
        pullCount: 199, bestPercent: 67.24, isDefeated: false,
      },
      {
        boss: { name: 'Imperator Averzian', slug: 'imperator-averzian', ordinal: 0, iconUrl: '/images/wow/icons/large/boss_a.jpg' },
        pullCount: 7, bestPercent: 0, isDefeated: 1,
      },
    ]);

    // Icon downloads: tiny fake image for every request.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([0xff, 0xd8]).buffer,
    });
  });

  afterEach(() => {
    closeDatabase();
    globalThis.fetch = originalFetch;
  });

  it('builds API sections newest-expansion-first, filtering Fated raids and zero-kill raids', async () => {
    const model = await buildAchievementsModel();
    const labels = model.sections.map((s) => s.expansionLabel);
    // Expansion 7 fixture ("Battle for Azeroth" name, but our fixture data) first, Legion second,
    // then manual sections (WoD before MoP).
    expect(labels).toEqual(['Battle for Azeroth', 'Legion', 'Warlords of Draenor', 'Mists of Pandaria']);
    const legion = model.sections[1]!;
    expect(legion.rows.map((r) => r.raid)).toEqual(['The Emerald Nightmare']);
  });

  it('marks CE and formats progress/result on merged rows', async () => {
    const model = await buildAchievementsModel();
    const en = model.sections[1]!.rows[0]!;
    expect(en.progress).toBe('2/2M');
    expect(en.isCE).toBe(true);
    expect(en.result).toBe('WR 818');
    expect(en.icon).toBe('achievement_zone_emeraldnightmare');
  });

  it('attaches an ordinal-sorted live breakdown to in-progress current-expansion raids', async () => {
    const model = await buildAchievementsModel();
    const current = model.sections[0]!.rows[0]!;
    expect(current.raid).toBe('MN Tier 1 (VS / DR / MQD)');
    expect(current.bosses).toHaveLength(2);
    expect(current.bosses![0]).toEqual({
      name: 'Imperator Averzian', icon: 'boss_a', pulls: 7, bestPercent: 0, defeated: true,
    });
    expect(current.bosses![1]).toEqual({
      name: 'Midnight Falls', icon: 'boss_b', pulls: 199, bestPercent: 67.24, defeated: false,
    });
    expect(vi.mocked(getLiveRaidProgress)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getLiveRaidProgress)).toHaveBeenCalledWith(
      expect.objectContaining({ realm: 'silvermoon' }),
      'tier-mn-1',
    );
  });

  it('includes manual sections with icons and resolves every referenced icon', async () => {
    const model = await buildAchievementsModel();
    const wod = model.sections.find((s) => s.expansionLabel === 'Warlords of Draenor')!;
    expect(wod.rows.map((r) => r.raid)).toEqual([
      'Hellfire Citadel', 'Blackrock Foundry', 'Highmaul',
    ]);
    const hfc = wod.rows[0]!;
    expect(hfc.icon).toBe('achievement_boss_hellfire_archimonde');
    expect(hfc.isCE).toBe(true);
    expect(hfc.result).toBe('WR 1170');

    for (const section of model.sections) {
      if (section.expansionIcon) expect(model.icons.has(section.expansionIcon)).toBe(true);
      for (const row of section.rows) {
        if (row.icon) expect(model.icons.has(row.icon)).toBe(true);
        for (const boss of row.bosses ?? []) {
          if (boss.icon) expect(model.icons.has(boss.icon)).toBe(true);
        }
      }
    }
  });

  it('propagates API errors (fail-fast, no partial model)', async () => {
    vi.mocked(getGuildRaidSummary).mockRejectedValue(new Error('rio down'));
    await expect(buildAchievementsModel()).rejects.toThrow('rio down');
  });

  it('serves ended-tier encounters from cache on the second build', async () => {
    await buildAchievementsModel();
    expect(vi.mocked(getGuildRaidEncounters)).toHaveBeenCalledTimes(1);
    await buildAchievementsModel();
    expect(vi.mocked(getGuildRaidEncounters)).toHaveBeenCalledTimes(1); // cached
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- achievementsData`
Expected: FAIL — `buildAchievementsModel` not exported.

- [ ] **Step 3: Implement**

Append to `src/functions/guild-info/achievementsData.ts`:

```ts
import { getDatabase } from '../../database/db.js';
import { config } from '../../config.js';
import {
  getRaidStaticData,
  getGuildRaidSummary,
  getGuildRaidEncounters,
  getLiveRaidProgress,
} from '../../services/raiderio.js';
import { getCachedOrFetch, getIconOrFetch, FOREVER } from '../../services/apiCache.js';
import type { AchievementsManualRow } from '../../types/index.js';
```

(Move these to the top of the file with the existing imports.)

```ts
// ─── Model ──────────────────────────────────────────────────────

export interface AchievementBossRow {
  name: string;
  icon: string | null;
  pulls: number;
  bestPercent: number;
  defeated: boolean;
}

export interface AchievementRaidRow {
  raid: string;
  icon: string | null;
  progress: string;
  isCE: boolean;
  result: string;
  bosses?: AchievementBossRow[];
}

export interface AchievementsSection {
  expansionLabel: string;
  expansionIcon: string | null;
  rows: AchievementRaidRow[];
}

export interface AchievementsModel {
  sections: AchievementsSection[];
  icons: Map<string, Buffer>;
}

const FIRST_API_EXPANSION = 6;

type StaticRaid = RaidStaticData['raids'][number];

/**
 * Assemble the full achievements model: static data (cached), two guild
 * profile calls (live), CE from encounter timestamps (cached for ended
 * tiers), live pull breakdown for in-progress current-expansion raids, and
 * every referenced icon resolved to a Buffer. Fail-fast: any fetch error
 * propagates to the caller.
 */
export async function buildAchievementsModel(): Promise<AchievementsModel> {
  // 1. Static data per expansion until one comes back empty.
  const staticByExpansion = new Map<number, RaidStaticData>();
  for (let exp = FIRST_API_EXPANSION; ; exp++) {
    const data = await getCachedOrFetch(`static-data:${exp}`, staticDataFreshness, () =>
      getRaidStaticData(exp),
    );
    if (!data.raids || data.raids.length === 0) break;
    staticByExpansion.set(exp, data);
  }

  const expansionIds = [...staticByExpansion.keys()];
  const currentExpansion = Math.max(...expansionIds);

  // 2. Guild standings, merged across identities (always live).
  const summaries = [];
  for (const identity of config.raiderIoGuilds) {
    summaries.push({ identity, summary: await getGuildRaidSummary(identity, expansionIds) });
  }
  const standings = mergeGuildSummaries(summaries);

  // 3. Build API sections, newest expansion first.
  const iconNames = new Set<string>();
  const sections: AchievementsSection[] = [];

  for (const exp of [...expansionIds].sort((a, b) => b - a)) {
    const raids = (staticByExpansion.get(exp)!.raids as StaticRaid[])
      .filter((r) => !r.slug.startsWith('fated-') && !r.slug.startsWith('awakened-'))
      .sort(byEndDateDescending);

    const rows: AchievementRaidRow[] = [];
    for (const raid of raids) {
      const standing = standings.get(raid.slug);
      if (!standing || standing.mythicKilled === 0) continue;

      const isCE = await resolveCE(raid, standing);
      const row: AchievementRaidRow = {
        raid: raid.name,
        icon: raid.icon ?? null,
        progress: `${standing.mythicKilled}/${standing.totalBosses}M`,
        isCE,
        result: standing.worldRank > 0 ? `WR ${standing.worldRank}` : '',
      };

      if (exp === currentExpansion && standing.mythicKilled < standing.totalBosses) {
        row.bosses = await resolveLiveBreakdown(raid.slug, standing.identity);
      }

      if (row.icon) iconNames.add(row.icon);
      for (const boss of row.bosses ?? []) if (boss.icon) iconNames.add(boss.icon);
      rows.push(row);
    }

    if (rows.length === 0) continue;

    const expansionIcon = expansionIconName(exp, rows[0]?.icon ?? null);
    if (expansionIcon) iconNames.add(expansionIcon);
    sections.push({ expansionLabel: getExpansionName(exp), expansionIcon, rows });
  }

  // 4. Manual sections (newest expansion first, newest raid first).
  for (const section of buildManualSections()) {
    if (section.expansionIcon) iconNames.add(section.expansionIcon);
    for (const row of section.rows) if (row.icon) iconNames.add(row.icon);
    sections.push(section);
  }

  // 5. Resolve all icons (cache-first; a failed download aborts the build).
  const icons = new Map<string, Buffer>();
  for (const name of iconNames) {
    icons.set(name, await getIconOrFetch(name, zamimgUrl(name)));
  }

  return { sections, icons };
}

function byEndDateDescending(a: StaticRaid, b: StaticRaid): number {
  const endA = a.ends.eu ?? '';
  const endB = b.ends.eu ?? '';
  if (!endA && !endB) return 0;
  if (!endA) return -1; // open-ended raids sort to the top
  if (!endB) return 1;
  return endB.localeCompare(endA);
}

async function resolveCE(
  raid: StaticRaid,
  standing: MergedStanding,
): Promise<boolean> {
  if (standing.mythicKilled < standing.totalBosses) return false;

  const tierEndsEu = raid.ends.eu;
  const tierEnded = tierEndsEu !== null && new Date(tierEndsEu).getTime() < Date.now();
  if (!tierEnded) return true; // full clear in an ongoing tier

  // Ended tier: need the last boss's first-kill timestamp (immutable → cache).
  const encounters = await getCachedOrFetch(
    `encounters:${standing.identity.realm}:${raid.slug}`,
    FOREVER,
    () => getGuildRaidEncounters(standing.identity, raid.slug),
  );
  const lastBossSlug = raid.encounters[raid.encounters.length - 1]?.slug;
  const lastKill = encounters.find((e) => e.slug === lastBossSlug);
  return determineCE({
    mythicKilled: standing.mythicKilled,
    totalBosses: standing.totalBosses,
    tierEndsEu,
    lastBossDefeatedAt: lastKill?.defeatedAt ?? null,
  });
}

async function resolveLiveBreakdown(
  raidSlug: string,
  identity: GuildIdentity,
): Promise<AchievementBossRow[]> {
  const bosses = await getLiveRaidProgress(identity, raidSlug);
  return [...bosses]
    .sort((a, b) => a.boss.ordinal - b.boss.ordinal)
    .map((b) => ({
      name: b.boss.name,
      icon: b.boss.iconUrl ? iconNameFromUrl(b.boss.iconUrl) : null,
      pulls: b.pullCount,
      bestPercent: b.bestPercent,
      defeated: Boolean(b.isDefeated),
    }));
}

function buildManualSections(): AchievementsSection[] {
  const db = getDatabase();
  const rows = db
    .prepare('SELECT * FROM achievements_manual ORDER BY expansion, sort_order')
    .all() as AchievementsManualRow[];

  const grouped = new Map<number, AchievementsManualRow[]>();
  for (const row of rows) {
    const existing = grouped.get(row.expansion) ?? [];
    existing.push(row);
    grouped.set(row.expansion, existing);
  }

  const sections: AchievementsSection[] = [];
  for (const [expansion, expRows] of grouped) {
    sections.push({
      expansionLabel: getExpansionName(expansion),
      expansionIcon: expansionIconName(expansion, null),
      rows: expRows
        .map((r) => {
          const isCE = r.result.includes('CE');
          const result = r.result
            .replace(/\*\*/g, '')
            .replace(/^CE\s*/, '')
            .trim();
          return { raid: r.raid, icon: r.icon, progress: r.progress, result, isCE };
        })
        .reverse(), // stored oldest-first; display newest-first
    });
  }
  // Stored ascending by expansion; display newest expansion first.
  return sections.reverse();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- achievementsData`
Expected: PASS (all suites in the file).

- [ ] **Step 5: Commit**

```bash
git add src/functions/guild-info/achievementsData.ts tests/unit/achievementsData.test.ts
git commit -m "feat(achievements): buildAchievementsModel - cached fetch, merge, CE, live breakdown"
```

---

### Task 7: achievementsRender

**Files:**
- Create: `src/functions/guild-info/achievementsRender.ts`
- Test: `tests/unit/achievementsRender.test.ts`

**Interfaces:**
- Consumes: `AchievementsModel` types from Task 6; `registerAchievementsFonts`, `ACHIEVEMENTS_FONT` from `./fonts.js`; `createCanvas`, `loadImage` from `@napi-rs/canvas`.
- Produces: `renderAchievementsImage(model: AchievementsModel): Promise<Buffer>` (async — icon decoding uses `loadImage`).

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/achievementsRender.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { renderAchievementsImage } from '../../src/functions/guild-info/achievementsRender.js';
import type { AchievementsModel } from '../../src/functions/guild-info/achievementsData.js';

// A real 4x4 PNG so loadImage can decode cached "icons".
function tinyPng(): Buffer {
  const canvas = createCanvas(4, 4);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(0, 0, 4, 4);
  return Buffer.from(canvas.toBuffer('image/png'));
}

function fixtureModel(): AchievementsModel {
  return {
    sections: [
      {
        expansionLabel: 'Midnight',
        expansionIcon: 'exp_icon',
        rows: [
          {
            raid: 'MN Tier 1 (VS / DR / MQD)',
            icon: 'raid_icon',
            progress: '1/2M',
            isCE: false,
            result: 'WR 2281',
            bosses: [
              { name: 'Imperator Averzian', icon: 'boss_a', pulls: 7, bestPercent: 0, defeated: true },
              { name: 'Midnight Falls', icon: 'boss_b', pulls: 199, bestPercent: 67.24, defeated: false },
            ],
          },
        ],
      },
      {
        expansionLabel: 'Warlords of Draenor',
        expansionIcon: null,
        rows: [
          { raid: 'Hellfire Citadel', icon: null, progress: '13/13M', isCE: true, result: 'WR 1170' },
        ],
      },
    ],
    icons: new Map([
      ['exp_icon', tinyPng()],
      ['raid_icon', tinyPng()],
      ['boss_a', tinyPng()],
      ['boss_b', tinyPng()],
    ]),
  };
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

describe('renderAchievementsImage', () => {
  it('renders a PNG with the expected width', async () => {
    const buffer = await renderAchievementsImage(fixtureModel());
    expect(buffer.subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
    // PNG IHDR width is bytes 16-19 big-endian.
    expect(buffer.readUInt32BE(16)).toBe(1400);
  });

  it('is taller when a raid has a boss breakdown', async () => {
    const withBosses = await renderAchievementsImage(fixtureModel());
    const model = fixtureModel();
    delete model.sections[0]!.rows[0]!.bosses;
    const without = await renderAchievementsImage(model);
    // Height is IHDR bytes 20-23.
    expect(withBosses.readUInt32BE(20)).toBeGreaterThan(without.readUInt32BE(20));
  });

  it('renders when icons are missing from the map (blank space, no throw)', async () => {
    const model = fixtureModel();
    model.icons.clear();
    const buffer = await renderAchievementsImage(model);
    expect(buffer.subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- achievementsRender`
Expected: FAIL with "Cannot find module .../achievementsRender.js".

- [ ] **Step 3: Implement**

Create `src/functions/guild-info/achievementsRender.ts`:

```ts
import { createCanvas, loadImage, type Image, type SKRSContext2D } from '@napi-rs/canvas';
import { registerAchievementsFonts, ACHIEVEMENTS_FONT } from './fonts.js';
import type { AchievementsModel, AchievementsSection } from './achievementsData.js';

// ─── Layout constants ───────────────────────────────────────────

const WIDTH = 1400;
const PADDING = 32;
const HEADER_HEIGHT = 56;
const ROW_HEIGHT = 44;
const BOSS_ROW_HEIGHT = 34;
const SECTION_GAP = 20;
const FONT_SIZE = 22;
const HEADER_FONT_SIZE = 24;
const BOSS_FONT_SIZE = 18;

const RAID_ICON_SIZE = 32;
const EXPANSION_ICON_SIZE = 28;
const BOSS_ICON_SIZE = 24;

const COL_RAID = PADDING;
const COL_RAID_TEXT = PADDING + RAID_ICON_SIZE + 12;
const COL_PROGRESS = 720;
const COL_CE = 900;
const COL_RESULT = 1060;

const BOSS_INDENT = PADDING + 40;
const COL_BOSS_TEXT = BOSS_INDENT + BOSS_ICON_SIZE + 10;

const CE_BADGE_W = 54;
const CE_BADGE_H = 26;
const CE_BADGE_RADIUS = 5;

// Discord dark palette.
const BG = '#2b2d31';
const HEADER_TEXT = '#96989d';
const RULE = '#3f4147';
const BLURPLE = '#5865f2';
const WHITE = '#ffffff';
const CE_GREEN = '#57f287';
const CE_BADGE_BG = '#248046';
const MUTED = '#96989d';
const PROG_GOLD = '#f0b232';

/** Render the achievements model to a PNG. Icons missing from the map leave blank space. */
export async function renderAchievementsImage(model: AchievementsModel): Promise<Buffer> {
  registerAchievementsFonts();

  const images = new Map<string, Image>();
  for (const [name, buffer] of model.icons) {
    images.set(name, await loadImage(buffer));
  }

  const height = computeHeight(model.sections);
  const canvas = createCanvas(WIDTH, height);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, WIDTH, height);

  // Column headers + underline.
  ctx.fillStyle = HEADER_TEXT;
  ctx.font = `bold ${HEADER_FONT_SIZE}px ${ACHIEVEMENTS_FONT}`;
  ctx.fillText('RAID', COL_RAID, PADDING + 20);
  ctx.fillText('PROGRESS', COL_PROGRESS, PADDING + 20);
  ctx.fillText('CE', COL_CE + 10, PADDING + 20);
  ctx.fillText('WORLD RANK', COL_RESULT, PADDING + 20);

  ctx.strokeStyle = RULE;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PADDING, PADDING + HEADER_HEIGHT - 4);
  ctx.lineTo(WIDTH - PADDING, PADDING + HEADER_HEIGHT - 4);
  ctx.stroke();

  // `y` is the text baseline of the current row.
  let y = PADDING + HEADER_HEIGHT + ROW_HEIGHT;

  for (const section of model.sections) {
    // Expansion header row.
    const expIcon = section.expansionIcon ? images.get(section.expansionIcon) : undefined;
    let labelX = COL_RAID;
    if (expIcon) {
      ctx.drawImage(expIcon, COL_RAID, y - EXPANSION_ICON_SIZE + 6, EXPANSION_ICON_SIZE, EXPANSION_ICON_SIZE);
      labelX = COL_RAID + EXPANSION_ICON_SIZE + 10;
    }
    ctx.fillStyle = BLURPLE;
    ctx.font = `bold ${FONT_SIZE}px ${ACHIEVEMENTS_FONT}`;
    ctx.fillText(section.expansionLabel, labelX, y);
    y += ROW_HEIGHT;

    for (const row of section.rows) {
      const rowIcon = row.icon ? images.get(row.icon) : undefined;
      if (rowIcon) {
        ctx.drawImage(rowIcon, COL_RAID, y - RAID_ICON_SIZE + 8, RAID_ICON_SIZE, RAID_ICON_SIZE);
      }

      const color = row.isCE ? CE_GREEN : WHITE;
      ctx.fillStyle = color;
      ctx.font = `${FONT_SIZE}px ${ACHIEVEMENTS_FONT}`;
      ctx.fillText(row.raid, COL_RAID_TEXT, y);
      ctx.fillText(row.progress, COL_PROGRESS, y);
      ctx.fillText(row.result, COL_RESULT, y);

      if (row.isCE) drawCeBadge(ctx, y);
      y += ROW_HEIGHT;

      for (const boss of row.bosses ?? []) {
        const bossIcon = boss.icon ? images.get(boss.icon) : undefined;
        if (bossIcon) {
          ctx.drawImage(bossIcon, BOSS_INDENT, y - BOSS_ICON_SIZE + 6, BOSS_ICON_SIZE, BOSS_ICON_SIZE);
        }

        ctx.fillStyle = boss.defeated ? MUTED : PROG_GOLD;
        ctx.font = `${BOSS_FONT_SIZE}px ${ACHIEVEMENTS_FONT}`;
        ctx.fillText(boss.name, COL_BOSS_TEXT, y);

        if (boss.defeated) {
          drawCheck(ctx, COL_PROGRESS, y);
          ctx.fillText(`${boss.pulls} pulls`, COL_PROGRESS + 26, y);
        } else {
          drawPlay(ctx, COL_PROGRESS, y);
          ctx.fillText(
            `${boss.pulls} pulls · best ${boss.bestPercent.toFixed(1)}%`,
            COL_PROGRESS + 26,
            y,
          );
        }
        y += BOSS_ROW_HEIGHT;
      }
    }

    y += SECTION_GAP;
  }

  return Buffer.from(canvas.toBuffer('image/png'));
}

function computeHeight(sections: AchievementsSection[]): number {
  let height = PADDING + HEADER_HEIGHT;
  for (const section of sections) {
    height += ROW_HEIGHT; // expansion header row
    for (const row of section.rows) {
      height += ROW_HEIGHT;
      height += (row.bosses?.length ?? 0) * BOSS_ROW_HEIGHT;
    }
    height += SECTION_GAP;
  }
  return height + PADDING;
}

function drawCeBadge(ctx: SKRSContext2D, baselineY: number): void {
  const badgeX = COL_CE;
  const badgeY = baselineY - CE_BADGE_H + 4;
  ctx.beginPath();
  ctx.roundRect(badgeX, badgeY, CE_BADGE_W, CE_BADGE_H, CE_BADGE_RADIUS);
  ctx.fillStyle = CE_BADGE_BG;
  ctx.fill();
  ctx.fillStyle = WHITE;
  ctx.font = `bold 16px ${ACHIEVEMENTS_FONT}`;
  const textWidth = ctx.measureText('CE').width;
  ctx.fillText('CE', badgeX + (CE_BADGE_W - textWidth) / 2, baselineY - 2);
}

// Drawn glyphs rather than font glyphs: the bundled DejaVu subset's coverage
// of ✓/▶ is unverified, and missing glyphs render as tofu boxes on Railway.
function drawCheck(ctx: SKRSContext2D, x: number, baselineY: number): void {
  ctx.strokeStyle = CE_GREEN;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x, baselineY - 8);
  ctx.lineTo(x + 5, baselineY - 3);
  ctx.lineTo(x + 14, baselineY - 14);
  ctx.stroke();
}

function drawPlay(ctx: SKRSContext2D, x: number, baselineY: number): void {
  ctx.fillStyle = PROG_GOLD;
  ctx.beginPath();
  ctx.moveTo(x, baselineY - 16);
  ctx.lineTo(x + 12, baselineY - 8);
  ctx.lineTo(x, baselineY);
  ctx.closePath();
  ctx.fill();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- achievementsRender`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/functions/guild-info/achievementsRender.ts tests/unit/achievementsRender.test.ts
git commit -m "feat(achievements): icon-enriched renderer with live boss breakdown"
```

---

### Task 8: Rewire updateAchievements, add flush option, docs, full verification

**Files:**
- Modify: `src/functions/guild-info/updateAchievements.ts` (major shrink)
- Modify: `src/commands/updateachievements.ts`
- Modify: `docs/commands.md`
- Test: `tests/e2e/commands/updateachievements.e2e.ts` (extend), full suites

**Interfaces:**
- Consumes: `buildAchievementsModel` (Task 6), `renderAchievementsImage` (Task 7), `flushCache` (Task 2).
- Produces: same external behaviour (message edit/post flow, `guild_info_messages` bookkeeping) plus the `flush` option.

- [ ] **Step 1: Rewrite updateAchievements.ts**

Replace the entire file with the orchestration-only version (the fetch/render logic now lives in the Task 5–7 modules; `fetchApiAchievements`, `buildManualSections`, `determineCE`, `renderAchievementsImage`, `EXPANSION_NAMES`, and the local interfaces are all deleted from this file):

```ts
import { type Client, AttachmentBuilder } from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';
import { getOrCreateGuildInfoChannel } from './clearGuildInfo.js';
import { buildAchievementsModel } from './achievementsData.js';
import { renderAchievementsImage } from './achievementsRender.js';
import type { GuildInfoContentRow, GuildInfoMessageRow } from '../../types/index.js';

/**
 * Generate the achievements image from manual + API data and post it to the
 * guild info channel. Fail-fast: any fetch or render error propagates to the
 * caller and the existing Discord message is left untouched.
 */
export async function updateAchievements(client: Client): Promise<void> {
  const channel = await getOrCreateGuildInfoChannel(client);
  if (!channel) {
    logger.warn('guild-info', 'Could not resolve guild info channel for Achievements');
    return;
  }

  const db = getDatabase();

  const titleRow = db
    .prepare('SELECT * FROM guild_info_content WHERE key = ?')
    .get('achievements_title') as GuildInfoContentRow | undefined;
  const title = titleRow?.title ?? 'Current Progress & Past Achievements';

  const model = await buildAchievementsModel();
  const imageBuffer = await renderAchievementsImage(model);
  const attachment = new AttachmentBuilder(imageBuffer, { name: 'achievements.png' });

  const existingMsg = db
    .prepare('SELECT * FROM guild_info_messages WHERE key = ?')
    .get('achievements') as GuildInfoMessageRow | undefined;

  if (existingMsg) {
    try {
      const oldMessage = await channel.messages.fetch(existingMsg.message_id);
      await oldMessage.edit({
        content: `**${title}**`,
        embeds: [],
        files: [attachment],
      });
      logger.info('guild-info', 'Updated existing Achievements message');
      return;
    } catch (error) {
      // Editing can fail because the stored message was deleted, the channel was
      // recreated, or the message was authored by a different bot identity. Log
      // the reason so a stray duplicate post is diagnosable rather than silent.
      logger.warn(
        'guild-info',
        `Could not edit existing achievements message ${existingMsg.message_id}, creating new one: ${error}`,
      );
    }
  }

  const message = await channel.send({
    content: `**${title}**`,
    files: [attachment],
  });

  db.prepare('INSERT OR REPLACE INTO guild_info_messages (key, message_id) VALUES (?, ?)').run(
    'achievements',
    message.id,
  );

  logger.info('guild-info', 'Posted Achievements image');
}
```

Check for stragglers: `npx tsc --noEmit` must pass, and `grep -rn "EXPANSION_NAMES\|getExpansionName" src/` must show only `achievementsData.ts` (plus `quipContext.ts` if it has its own copy — leave that file alone).

- [ ] **Step 2: Add the flush option to the command**

Replace `src/commands/updateachievements.ts` with:

```ts
import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import { requireOfficer, audit } from '../utils.js';
import { updateAchievements } from '../functions/guild-info/updateAchievements.js';
import { flushCache } from '../services/apiCache.js';

export default {
  data: new SlashCommandBuilder()
    .setName('updateachievements')
    .setDescription('Refresh achievements embed only')
    .addBooleanOption((option) =>
      option
        .setName('flush')
        .setDescription('Clear the Raider.IO/icon cache and refetch everything')
        .setRequired(false),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction: ChatInputCommandInteraction) {
    if (!(await requireOfficer(interaction))) return;

    const flush = interaction.options.getBoolean('flush') ?? false;

    await interaction.reply({ content: 'Updating achievements...', flags: MessageFlags.Ephemeral });

    if (flush) flushCache();

    try {
      await updateAchievements(interaction.client);
    } catch (error) {
      await interaction.editReply({ content: `Achievements update failed: ${error}` });
      return;
    }

    await audit(interaction.user, 'refreshed achievements', 'achievements embed');
    await interaction.editReply({
      content: flush ? 'Achievements updated (cache flushed).' : 'Achievements updated.',
    });
  },
};
```

- [ ] **Step 3: Extend the e2e test**

Append to the `describe('/updateachievements', …)` block in `tests/e2e/commands/updateachievements.e2e.ts`:

```ts
  it(
    'officer with flush:true — empties the cache tables and reports the flush',
    { timeout: 120_000 },
    async () => {
      const ctx = getE2EContext();
      const channel = ctx.guild.systemChannel as TextBasedChannel;

      const iact = fakeChatInput({
        client: ctx.client,
        guild: ctx.guild,
        channel,
        member: ctx.officer,
        user: ctx.officer.user,
        commandName: 'updateachievements',
        options: { flush: true },
      });

      await updateachievementsCmd.execute(iact as unknown as ChatInputCommandInteraction);

      expect(iact.__editedReply).not.toBeNull();
      const editedContent =
        typeof iact.__editedReply!.options === 'string'
          ? iact.__editedReply!.options
          : ((iact.__editedReply!.options as { content?: string }).content ?? '');
      expect(editedContent).toMatch(/cache flushed/i);
    },
  );
```

`fakeChatInput` already supports this: its `options?: Record<string, unknown>` init field feeds the shim's `getBoolean` (verified in `tests/e2e/setup/synthesizer.ts`), so `options: { flush: true }` needs no synthesizer changes. Also update the stale timing comment at the top of the first test (`// raider.io calls: static-data per expansion (6+) + rankings per raid` → `// raider.io calls: static data + guild profiles + live progress`).

- [ ] **Step 4: Update docs**

In `docs/commands.md`, find the `/updateachievements` entry and extend its description with:

```
Optional `flush:true` clears the Raider.IO response/icon cache before rebuilding, forcing a full refetch (use after a new tier is added or if the image looks stale).
```

- [ ] **Step 5: Run the full verification suite**

```bash
npm run typecheck && npm run lint && npm run format:check && npm test && npm run test:integration
```

Expected: all pass. If `format:check` fails, run `npm run format` and re-check.

Then the e2e suite (hits real raider.io; needs the e2e Discord env):

```bash
npm run test:e2e -- updateachievements
```

Expected: PASS — both tests.

- [ ] **Step 6: Commit**

```bash
git add src/functions/guild-info/updateAchievements.ts src/commands/updateachievements.ts tests/e2e/commands/updateachievements.e2e.ts docs/commands.md
git commit -m "feat(achievements): rewire to new data/render pipeline, add flush option"
```

- [ ] **Step 7: Manual verification on the test server (do not skip)**

1. Push `main` (deploys the test bot — avoid pushing while a long-running command is in flight).
2. `/deploy-commands` is NOT automatic: run `npm run deploy-commands` if the command schema changed (the new `flush` option requires it).
3. On the test server run `/updateachievements` and inspect the image:
   - Raid icons on every API row, icons on the four manual rows, expansion header icons.
   - The in-progress Midnight raid shows the per-boss breakdown with pulls and the gold prog-boss line.
   - **CE badges match the current prod image raid-for-raid** — this validates the `defeatedAt` first-kill assumption from the spec. If any CE badge differs, stop and investigate before promoting (compare against `raider.io/guilds/eu/silvermoon/SeriouslyCasual`).
4. Run `/updateachievements flush:true` and confirm it completes and reports the flush.
5. Check `/status` shows the `updateAchievements` task healthy after the next daily run.

---

## Self-Review Notes

- Spec coverage: fetch consolidation (T4/T6), icons incl. manual + expansion (T1/T5/T6/T7), live breakdown (T4/T6/T7), cache + policy (T2/T5/T6), flush (T8), fail-fast (T6/T8), v9 migration (T1), CE via `defeatedAt` with manual validation gate (T6/T8 step 7).
- Deviation from spec noted inline: rows carry `result: string` instead of `worldRank: number` so manual rows share the shape.
- `getRaidRankings`/`RAIDERIO_GUILD_IDS` untouched (quips) — verified no other achievements callers remain in T8 step 1.

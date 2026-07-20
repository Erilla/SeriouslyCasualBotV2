# Build Number in Startup Logs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Log a per-commit build number (commit count of the deployed SHA) at bot startup, resolved via one cached GitHub API call.

**Architecture:** A new `buildInfo` service resolves `RAILWAY_GIT_COMMIT_SHA` to a commit count using the GitHub commits API `Link` pagination header, caching results by SHA in a new `build_info` SQLite table (schema migration v8). Locally it falls back to `git rev-list --count HEAD`. `src/index.ts` logs the result as its startup banner.

**Tech Stack:** Node 22 ESM + TypeScript, better-sqlite3, native `fetch`, vitest.

**Spec:** `docs/superpowers/specs/2026-07-20-build-number-logging-design.md`

## Global Constraints

- ESM project: relative imports MUST end in `.js` even from `.ts` files (e.g. `'../database/db.js'`).
- Unit tests live in `tests/unit/` and run with `npm test` (vitest default project).
- CI blocks on `npm run format:check` (prettier) as well as lint — run `npm run format` before every commit.
- Migration pattern: new tables go in BOTH `createTables` (`src/database/schema.ts`, fresh DBs) and a guarded `IF NOT EXISTS` migration block in `runMigrations` (`src/database/db.ts`, existing DBs).
- The log line format is exactly: `Starting SeriouslyCasualBot (build 171, 9800798)`; on lookup failure `(build ?, 9800798)`; with no git info at all `(dev)`. No semver prefix.
- GitHub fallback coordinates: owner `Erilla`, repo `SeriouslyCasualBotV2`.
- Do NOT push to origin during this plan — pushing main deploys and restarts the test bot. Local commits only; the user pushes.

---

### Task 1: `build_info` cache table (schema migration v8)

**Files:**
- Modify: `src/database/schema.ts` (append table to the `createTables` exec block)
- Modify: `src/database/db.ts` (add migration v8 after the v7 block, `src/database/db.ts:146-160`)
- Modify: `tests/integration/database-schema.test.ts:76` (schema version assertion 7 → 8; table-name assertion)
- Test: `tests/unit/db-migration.test.ts`

**Interfaces:**
- Consumes: existing `runMigrations(database)` / `createTables(db)` pattern.
- Produces: table `build_info (sha TEXT PRIMARY KEY, build INTEGER NOT NULL)` — Task 2 reads/writes it via SQL.

- [ ] **Step 1: Write the failing migration test**

Append to `tests/unit/db-migration.test.ts` (before the final `initDatabase` describe block):

```typescript
describe('runMigrations — v8 adds the build_info cache table', () => {
  it('creates build_info on a legacy DB missing it', () => {
    const db = getDatabase();

    // Represent a pre-v8 install: createTables in beforeEach created the
    // table, so drop it and replay migrations.
    db.exec('DROP TABLE IF EXISTS build_info;');
    db.exec('DELETE FROM schema_version;');

    runMigrations(db);

    const table = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='build_info'`)
      .get();
    expect(table).toBeDefined();

    const version = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as {
      v: number;
    };
    expect(version.v).toBeGreaterThanOrEqual(8);
  });

  it('is a no-op on a fresh DB where the table already exists', () => {
    const db = getDatabase();

    expect(() => runMigrations(db)).not.toThrow();
    expect(() => runMigrations(db)).not.toThrow();

    const table = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='build_info'`)
      .get();
    expect(table).toBeDefined();
  });
});
```

Also update the two existing assertions in `tests/integration/database-schema.test.ts`:
- After the `expect(tableNames).toContain('quip_history');` line add:
  ```typescript
  expect(tableNames).toContain('build_info');
  ```
- Change `expect(version.version).toBe(7);` to `expect(version.version).toBe(8);`

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/unit/db-migration.test.ts`
Expected: FAIL — the two new v8 tests fail (`build_info` table not found / max version is 7).

Run: `npm run test:integration`
Expected: FAIL — `build_info` not in table names; version is 7 not 8.

- [ ] **Step 3: Implement the table + migration**

In `src/database/schema.ts`, append inside the `db.exec(\`...\`)` template, at the end (after the last table, keeping the numbered-comment style — use the next number in sequence):

```sql
    -- 25. build_info (build-number cache, keyed by deployed commit SHA)
    CREATE TABLE IF NOT EXISTS build_info (
      sha   TEXT PRIMARY KEY,
      build INTEGER NOT NULL
    );
```

(The current last table is `-- 24. quip_history`, so this is 25.)

In `src/database/db.ts`, after the `if (currentVersion < 7) { ... }` block (ends line 160), add:

```typescript
  if (currentVersion < 8) {
    // Cache for the startup build number: maps a deployed commit SHA to its
    // commit count so each build makes at most one GitHub API call across
    // restarts. Fresh DBs get the table from createTables; IF NOT EXISTS
    // keeps this idempotent there.
    database.transaction(() => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS build_info (
          sha   TEXT PRIMARY KEY,
          build INTEGER NOT NULL
        );
      `);
      database.prepare('INSERT INTO schema_version (version) VALUES (?)').run(8);
    })();
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/unit/db-migration.test.ts` — Expected: PASS
Run: `npm run test:integration` — Expected: PASS

- [ ] **Step 5: Format, lint, commit**

```bash
npm run format && npm run lint && npm run typecheck
git add src/database/schema.ts src/database/db.ts tests/unit/db-migration.test.ts tests/integration/database-schema.test.ts
git commit -m "feat(db): add build_info cache table (migration v8)"
```

---

### Task 2: `buildInfo` service

**Files:**
- Create: `src/services/buildInfo.ts`
- Test: `tests/unit/buildInfo.test.ts`

**Interfaces:**
- Consumes: `getDatabase()` from `src/database/db.js`; table `build_info` from Task 1; env vars `RAILWAY_GIT_COMMIT_SHA`, `RAILWAY_GIT_REPO_OWNER`, `RAILWAY_GIT_REPO_NAME`.
- Produces: `getBuildInfo(): Promise<BuildInfo>` where `interface BuildInfo { build: number | null; sha: string | null }` — Task 3 calls this. On Railway, `sha` is the full 40-char SHA (caller shortens for display); locally it is already the short SHA from `git rev-parse --short`.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/buildInfo.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getDatabase, closeDatabase } from '../../src/database/db.js';
import { createTables } from '../../src/database/schema.js';
import { getBuildInfo } from '../../src/services/buildInfo.js';

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
    expect(getDatabase().prepare('SELECT build FROM build_info WHERE sha = ?').get(SHA)).toBeUndefined();
  });

  it('returns build null on a non-2xx response', async () => {
    vi.stubEnv('RAILWAY_GIT_COMMIT_SHA', SHA);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, headers: new Headers() }));

    const info = await getBuildInfo();

    expect(info).toEqual({ build: null, sha: SHA });
  });

  it('returns build null when the Link header is missing', async () => {
    vi.stubEnv('RAILWAY_GIT_COMMIT_SHA', SHA);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(null)));

    const info = await getBuildInfo();

    expect(info).toEqual({ build: null, sha: SHA });
    expect(getDatabase().prepare('SELECT build FROM build_info WHERE sha = ?').get(SHA)).toBeUndefined();
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
```

Note: `vi.stubEnv('RAILWAY_GIT_COMMIT_SHA', '')` — the implementation must treat empty string as unset (falsy check), which the code below does.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/unit/buildInfo.test.ts`
Expected: FAIL — cannot resolve `../../src/services/buildInfo.js` (module does not exist).

- [ ] **Step 3: Implement the service**

Create `src/services/buildInfo.ts`:

```typescript
import { execFileSync } from 'child_process';
import { getDatabase } from '../database/db.js';

export interface BuildInfo {
  build: number | null;
  sha: string | null;
}

const FETCH_TIMEOUT_MS = 3000;

/**
 * Resolve the running build's identity. The build number is the commit count
 * of the deployed SHA (git rev-list --count semantics), so it increments by
 * exactly 1 per commit on main and matches between test and prod for the
 * same commit (prod is a fast-forward of main).
 *
 * On Railway: RAILWAY_GIT_COMMIT_SHA is set, but the Docker build context has
 * no .git, so the count comes from one unauthenticated GitHub API call,
 * cached in SQLite by SHA (at most one call per build, across restarts).
 * Failures return build: null (logged as "build ?") and are NOT cached, so
 * the next restart retries.
 */
export async function getBuildInfo(): Promise<BuildInfo> {
  const sha = process.env.RAILWAY_GIT_COMMIT_SHA;
  if (!sha) return localGitInfo();

  const db = getDatabase();
  const cached = db.prepare('SELECT build FROM build_info WHERE sha = ?').get(sha) as
    | { build: number }
    | undefined;
  if (cached) return { build: cached.build, sha };

  const build = await fetchCommitCount(sha);
  if (build !== null) {
    db.prepare('INSERT OR REPLACE INTO build_info (sha, build) VALUES (?, ?)').run(sha, build);
  }
  return { build, sha };
}

async function fetchCommitCount(sha: string): Promise<number | null> {
  const owner = process.env.RAILWAY_GIT_REPO_OWNER || 'Erilla';
  const repo = process.env.RAILWAY_GIT_REPO_NAME || 'SeriouslyCasualBotV2';
  const url = `https://api.github.com/repos/${owner}/${repo}/commits?sha=${sha}&per_page=1`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;

    // With per_page=1 the total commit count is the page number of the
    // rel="last" link, e.g. <https://...&page=171>; rel="last".
    const match = res.headers.get('link')?.match(/[?&]page=(\d+)>;\s*rel="last"/);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function localGitInfo(): BuildInfo {
  try {
    const build = Number(
      execFileSync('git', ['rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim(),
    );
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    return { build: Number.isFinite(build) && build > 0 ? build : null, sha };
  } catch {
    return { build: null, sha: null };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/unit/buildInfo.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Format, lint, commit**

```bash
npm run format && npm run lint && npm run typecheck
git add src/services/buildInfo.ts tests/unit/buildInfo.test.ts
git commit -m "feat(build): resolve build number from deployed commit via cached GitHub lookup"
```

---

### Task 3: Log the build number at startup

**Files:**
- Modify: `src/index.ts:16-23` (the `─── Initialize ───` section)

**Interfaces:**
- Consumes: `getBuildInfo()` from Task 2 (`src/services/buildInfo.js`). `sha` may be a full 40-char SHA (Railway) — display uses `sha.slice(0, 7)`, which is also a no-op on an already-short local SHA.
- Produces: startup log line `Starting SeriouslyCasualBot (build N, abcdef1)` / `(build ?, abcdef1)` / `(dev)`.

- [ ] **Step 1: Rewire the initialise section**

In `src/index.ts`, add to the imports:

```typescript
import { getBuildInfo } from './services/buildInfo.js';
```

Replace the current initialise block:

```typescript
initLogger(config.logLevel);
registerProcessErrorHandlers();
logger.info('bot', 'Starting SeriouslyCasualBot...');

initDatabase();
logger.info('bot', 'Database initialized');
```

with (DB must init before `getBuildInfo()` — the cache lives in SQLite):

```typescript
initLogger(config.logLevel);
registerProcessErrorHandlers();

initDatabase();
const { build, sha } = await getBuildInfo();
logger.info(
  'bot',
  `Starting SeriouslyCasualBot ${sha ? `(build ${build ?? '?'}, ${sha.slice(0, 7)})` : '(dev)'}`,
);
logger.info('bot', 'Database initialized');
```

- [ ] **Step 2: Verify the local-git path end-to-end**

`src/index.ts` is a side-effect module (no unit tests, per repo convention), so smoke-test the wiring directly. Run from the repo root:

```bash
npx tsx -e "import { initDatabase } from './src/database/db.js'; import { getBuildInfo } from './src/services/buildInfo.js'; initDatabase(':memory:'); const i = await getBuildInfo(); console.log(\`Starting SeriouslyCasualBot (build \${i.build ?? '?'}, \${i.sha})\`)"
```

Expected output: `Starting SeriouslyCasualBot (build <number ≥ 173>, <short-sha>)` — the current local commit count and short SHA.

- [ ] **Step 3: Run the full suite**

```bash
npm test && npm run test:integration && npm run typecheck && npm run lint && npm run format:check
```

Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(bot): log build number and commit SHA at startup"
```

---

## Post-plan notes (for the human, not the executor)

- Do not push mid-run of anything on the test bot; a push to main deploys immediately.
- First deploy after pushing: the startup line should read `(build <n>, <sha>)` in Railway logs. If it reads `build ?`, the GitHub call failed (likely rate limit on Railway's shared egress IP) — it will self-heal on the next restart, and if it happens persistently we can add a `GITHUB_TOKEN` env var later (60 → 5000 req/h).
- Promoting to prod (`git push origin origin/main:prod`) deploys the same SHA — prod logs the same build number.

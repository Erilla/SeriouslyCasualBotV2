# Build Number in Startup Logs — Design

**Date:** 2026-07-20
**Status:** Approved

## Problem

There is no way to tell which build of the bot is running. `package.json` is a static
`2.0.0`, nothing stamps builds, and the only identifier is the git SHA visible from the
Railway dashboard — not from the bot itself. With trunk-based deploys (main → test env,
prod branch fast-forwarded from main → prod env), we want a numeric version that
increments by exactly 1 for every commit on main, shown in the logs at startup.

## Chosen approach

**Runtime lookup, cached in SQLite.** The build number is the **commit count of the
deployed commit** (`git rev-list --count <sha>` semantics). It needs no version file, no
bump commits, no CI changes, and no manual steps. Because prod is a fast-forward of
main, the same commit produces the same build number in both environments.

Approaches rejected:

- **Bump commit via GitHub Action** — doubles commits and Railway deploys per push
  (test bot restarts twice).
- **CI-driven deploys (`railway up`)** — deterministic but replaces the branch
  auto-deploy configured in the Railway dashboard and adds token/workflow plumbing.
- **Build-time `git rev-list` in the Dockerfile** — Railway's build context does not
  include `.git`.

## Log line

First startup log line, before anything else initialises:

```
Starting SeriouslyCasualBot (build 171, 9800798)
```

- `build 171` — commit count of the deployed SHA.
- `9800798` — short SHA (first 7 chars).
- If the build number cannot be resolved: `(build ?, 9800798)`.
- Local dev with no git available: `(dev)`.

No semver prefix — `package.json`'s `2.0.0` is static and would be misleading.

## Components

### `src/services/buildInfo.ts` (new)

Exports `getBuildInfo(): Promise<BuildInfo>` where
`BuildInfo = { build: number | null; sha: string | null }`.

Resolution order:

1. **Railway:** `process.env.RAILWAY_GIT_COMMIT_SHA` is set.
   - Check the `build_info` cache table for that SHA; on hit, return it.
   - On miss, `GET https://api.github.com/repos/<owner>/<repo>/commits?sha=<sha>&per_page=1`
     (unauthenticated; repo is public). The total count is the `page` number of the
     `rel="last"` link in the `Link` response header. Owner/repo come from
     `RAILWAY_GIT_REPO_OWNER` / `RAILWAY_GIT_REPO_NAME` with hardcoded fallbacks
     `Erilla` / `SeriouslyCasualBotV2`.
   - Cache the result keyed by SHA, return it.
   - On any failure (network error, non-2xx, missing `Link` header, timeout):
     return `{ build: null, sha }` and **do not cache**, so the next restart retries.
   - Fetch is bounded by a ~3s `AbortSignal.timeout` so startup is never held hostage.
2. **Local dev:** env var absent — run `git rev-list --count HEAD` and
   `git rev-parse --short HEAD` via `child_process`. If git fails, return
   `{ build: null, sha: null }`.

### Cache: schema migration v8

New table in `src/database/db.ts` following the existing migration pattern:

```sql
CREATE TABLE IF NOT EXISTS build_info (
  sha   TEXT PRIMARY KEY,
  build INTEGER NOT NULL
);
```

One row per deployed SHA. A given build makes at most one GitHub API call in its
lifetime, across all restarts. Rows survive promotion to prod (same SHA, same count).

### Wiring: `src/index.ts`

DB init runs first (the cache needs it), then `await getBuildInfo()`, then the version
line via `logger.info('bot', ...)`, then the rest of startup unchanged. Worst case adds
~3s to the first cold boot of a brand-new build only.

## Error handling

- GitHub unreachable / rate-limited → `build ?` logged, retried on next restart.
- Malformed `Link` header → treated as failure, same path.
- The bot never fails to start because of build-info resolution.

## Testing

Unit tests for `buildInfo.ts` (mock `fetch`, in-memory DB per existing test patterns):

- `Link` header parsing → correct count.
- Cache hit → no fetch performed.
- Fetch failure → `build: null`, nothing cached.
- Success → result cached; second call reads cache.
- Local-git fallback path.

Plus the standard migration upgrade test for schema v8 (pattern exists for v7).

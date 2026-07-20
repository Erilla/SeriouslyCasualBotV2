import { execFileSync } from 'child_process';
import { getDatabase } from '../database/db.js';
import { logger } from './logger.js';
import type { BuildInfoRow } from '../types/index.js';

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
    | BuildInfoRow
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
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?sha=${encodeURIComponent(sha)}&per_page=1`;

  // Unauthenticated requests share GitHub's 60 req/h per-IP limit, which
  // Railway's shared egress IP routinely exhausts (403). A GITHUB_TOKEN env
  // var (fine-grained PAT, public read-only) lifts this to 5000 req/h.
  const token = process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};

  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      logger.warn('bot', `buildInfo: GitHub commit lookup failed with status ${res.status}`);
      return null;
    }

    // With per_page=1 the total commit count is the page number of the
    // rel="last" link, e.g. <https://...&page=171>; rel="last".
    const match = res.headers.get('link')?.match(/[?&]page=(\d+)>;\s*rel="last"/);
    if (!match) {
      logger.warn('bot', 'buildInfo: GitHub response missing a parseable Link header');
      return null;
    }
    return Number(match[1]);
  } catch (error) {
    const err = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    logger.warn('bot', `buildInfo: GitHub commit lookup threw — ${err}`);
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

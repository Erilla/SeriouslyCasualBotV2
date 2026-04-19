import Database from 'better-sqlite3';
import { existsSync, unlinkSync } from 'fs';
import { loadE2EEnv } from './env.js';

export function testDbPath(): string {
  return loadE2EEnv().testDbPath;
}

// Single cached readonly connection per worker — assertion helpers can
// query it directly without opening/closing a handle per query. Invalidated
// by wipeTestDb before the file is unlinked.
let cachedReadonly: Database.Database | null = null;

export function getReadonlyTestDb(): Database.Database {
  if (!cachedReadonly) {
    cachedReadonly = new Database(testDbPath(), { readonly: true, fileMustExist: true });
  }
  return cachedReadonly;
}

function closeReadonly(): void {
  if (cachedReadonly) {
    cachedReadonly.close();
    cachedReadonly = null;
  }
}

export async function wipeTestDb(): Promise<void> {
  // Release our own readonly handle first so the unlink doesn't fight it.
  closeReadonly();

  const path = testDbPath();
  // Remove WAL-mode auxiliary files first, then the main DB file.
  // On Windows, SQLite WAL mode keeps the -shm file locked briefly after
  // db.close(), which can cascade to an EBUSY on the main file.
  // Strategy: delete auxiliaries (silently), then retry the main file.
  for (const suffix of ['-wal', '-shm']) {
    const p = path + suffix;
    if (existsSync(p)) {
      try { unlinkSync(p); } catch { /* auxiliary — ignore */ }
    }
  }
  if (!existsSync(path)) return;

  // Retry the main file up to 5 times with brief yielding pauses.
  // better-sqlite3 releases OS handles synchronously on close(), but on
  // Windows the filesystem itself can return EBUSY for one or two scheduler
  // ticks after close — this retry handles that OS-level timing, not a
  // connection leak on our side (closeDatabase + closeReadonly both ran).
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      unlinkSync(path);
      return; // success
    } catch (err) {
      lastErr = err;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw lastErr;
}

/** @deprecated Use getReadonlyTestDb() — callers must not close the returned handle. */
export function openTestDbReadonly(): Database.Database {
  return getReadonlyTestDb();
}

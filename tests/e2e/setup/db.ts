import Database from 'better-sqlite3';
import { existsSync, unlinkSync } from 'fs';
import { loadE2EEnv } from './env.js';

export function testDbPath(): string {
  return loadE2EEnv().testDbPath;
}

export function wipeTestDb(): void {
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
  // better-sqlite3 releases OS handles synchronously on close(), but
  // Windows may return EBUSY for one or two scheduler ticks afterward.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      unlinkSync(path);
      return; // success
    } catch (err) {
      lastErr = err;
      // Spin-wait a few microseconds to yield to the OS scheduler.
      const end = Date.now() + 20;
      while (Date.now() < end) { /* busy-wait */ }
    }
  }
  throw lastErr;
}

export function openTestDbReadonly(): Database.Database {
  return new Database(testDbPath(), { readonly: true, fileMustExist: true });
}

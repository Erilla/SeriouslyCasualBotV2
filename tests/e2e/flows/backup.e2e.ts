/**
 * Flow: dailyBackup scheduled-job handler (bypass scheduler / node-cron).
 *
 * Strategy
 * --------
 * `dailyBackup()` is exported from src/functions/backups/dailyBackup.ts and
 * registered with `scheduler.registerCron` in src/events/ready.ts.  We import
 * and invoke it directly — no scheduler wiring needed.
 *
 * The function:
 *   1. Resolves BACKUP_DIR = resolve(process.cwd(), 'backups').
 *   2. Creates the directory if it does not exist.
 *   3. Writes a SQLite backup to BACKUP_DIR/db-<YYYY-MM-DD>.sqlite.
 *   4. Prunes old backups beyond MAX_BACKUPS (7).
 *
 * Test approach
 * -------------
 * - resetAndSeed({ discord: false }) — no Discord needed; the function only
 *   touches the filesystem and the SQLite database.
 * - Call dailyBackup() directly.
 * - Assert: the expected backup file was written and is a non-empty SQLite file.
 * - Cleanup: remove all db-*.sqlite files from BACKUP_DIR in afterEach to
 *   avoid polluting the working directory across runs.
 *
 * Pruning path
 * ------------
 * We seed MAX_BACKUPS + 1 (8) fake backup files with synthetic past dates so
 * that the pruning branch is exercised.  After the real backup runs, the total
 * should be MAX_BACKUPS (7): the oldest synthetic file should be deleted.
 *
 * Assertions
 * ----------
 * 1. dailyBackup() writes a file named db-<today>.sqlite to ./backups/.
 * 2. The written file is non-empty (backup content is present).
 * 3. dailyBackup() does not throw even when called a second time (idempotent
 *    for the same calendar day — backup() overwrites the file).
 * 4. When more than MAX_BACKUPS backup files exist before the run, the oldest
 *    files are pruned so that at most MAX_BACKUPS remain.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readdirSync, unlinkSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { statSync } from 'fs';
import { resetAndSeed } from '../setup/baseline.js';
import { dailyBackup } from '../../../src/functions/backups/dailyBackup.js';

// ---------------------------------------------------------------------------
// Constants — must mirror dailyBackup.ts without importing its internals
// ---------------------------------------------------------------------------

const BACKUP_DIR = resolve(process.cwd(), 'backups');
const MAX_BACKUPS = 7;

// Freeze the clock to a known instant so the filename `dailyBackup` computes
// from `new Date()` and the one the test asserts on can never disagree across
// a midnight boundary while the backup is in flight.
const FROZEN_NOW = new Date('2026-06-15T12:00:00Z');
const FROZEN_DATE_STR = '2026-06-15';

/** Full path to the frozen-date expected backup file. */
function todayFile(): string {
  return join(BACKUP_DIR, `db-${FROZEN_DATE_STR}.sqlite`);
}

// ---------------------------------------------------------------------------
// Cleanup helper — removes all db-*.sqlite files from BACKUP_DIR
// ---------------------------------------------------------------------------

function cleanBackupDir(): void {
  if (!existsSync(BACKUP_DIR)) return;
  const files = readdirSync(BACKUP_DIR).filter(
    (f) => f.startsWith('db-') && f.endsWith('.sqlite'),
  );
  for (const f of files) {
    unlinkSync(join(BACKUP_DIR, f));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('backup — dailyBackup scheduled-job flow', () => {
  beforeEach(async () => {
    // DB-only: dailyBackup() reads from the open SQLite connection, no Discord.
    await resetAndSeed({ discord: false });
    // Remove any leftover backup files from a previous run.
    cleanBackupDir();
    // Freeze Date to mid-day UTC so filename generation is deterministic.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(FROZEN_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    // Always clean up so the working directory stays tidy.
    cleanBackupDir();
  });

  // =========================================================================
  // 1. Backup file is written
  // =========================================================================

  it('writes a backup file named db-<today>.sqlite to ./backups/', async () => {
    await dailyBackup();

    const expected = todayFile();
    expect(existsSync(expected), `backup file must exist at ${expected}`).toBe(true);
  });

  // =========================================================================
  // 2. Backup file is non-empty
  // =========================================================================

  it('backup file is non-empty (contains SQLite data)', async () => {
    await dailyBackup();

    const size = statSync(todayFile()).size;
    expect(size, 'backup file must be larger than 0 bytes').toBeGreaterThan(0);
  });

  // =========================================================================
  // 3. Idempotent for the same calendar day (no throw on second call)
  // =========================================================================

  it('does not throw when called twice on the same day', async () => {
    await expect(dailyBackup()).resolves.not.toThrow();
    await expect(dailyBackup()).resolves.not.toThrow();

    // File should still exist and remain non-empty.
    expect(existsSync(todayFile())).toBe(true);
    expect(statSync(todayFile()).size).toBeGreaterThan(0);
  });

  // =========================================================================
  // 4. Old backups are pruned when count exceeds MAX_BACKUPS
  // =========================================================================

  it('prunes oldest backup files so at most MAX_BACKUPS remain after the run', async () => {
    // Ensure BACKUP_DIR exists before writing synthetic files.
    if (!existsSync(BACKUP_DIR)) {
      mkdirSync(BACKUP_DIR, { recursive: true });
    }

    // Write MAX_BACKUPS + 1 synthetic backup files with past dates.
    // Dates are all older than today so they sort before today's file.
    // Oldest = 2024-01-01, newest synthetic = 2024-01-08  (8 files total).
    const syntheticFiles: string[] = [];
    for (let i = 1; i <= MAX_BACKUPS + 1; i++) {
      const date = `2024-01-${String(i).padStart(2, '0')}`;
      const name = `db-${date}.sqlite`;
      writeFileSync(join(BACKUP_DIR, name), 'fake-sqlite-content');
      syntheticFiles.push(name);
    }

    // Pre-condition: 8 synthetic files exist.
    const before = readdirSync(BACKUP_DIR).filter(
      (f) => f.startsWith('db-') && f.endsWith('.sqlite'),
    );
    expect(before.length).toBe(MAX_BACKUPS + 1);

    // Run the backup — adds today's real file, then prunes to MAX_BACKUPS.
    await dailyBackup();

    // Post-condition: at most MAX_BACKUPS files remain.
    const after = readdirSync(BACKUP_DIR).filter(
      (f) => f.startsWith('db-') && f.endsWith('.sqlite'),
    );
    expect(after.length).toBeLessThanOrEqual(MAX_BACKUPS);

    // Today's backup must still be present (it is the newest, should not be pruned).
    expect(after).toContain(`db-${FROZEN_DATE_STR}.sqlite`);

    // The oldest synthetic file (2024-01-01) must have been deleted.
    expect(after).not.toContain('db-2024-01-01.sqlite');
  });
});

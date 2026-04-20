/**
 * Flow: threadUpdate event handler (thread keep-alive).
 *
 * Strategy
 * --------
 * `threadUpdateEvent` (default export from src/events/threadUpdate.ts) fires
 * whenever a Discord thread is updated.  When a thread transitions from
 * archived=false to archived=true, the handler looks up the thread_id in
 * `trials` and `applications` and calls `thread.setArchived(false)` to
 * re-open it.
 *
 * We test the handler directly without any scheduler or Discord gateway
 * wiring:
 *
 *   1. resetAndSeed({ discord: false }) — seeds a trial and application in the
 *      DB with null thread_ids.
 *   2. Patch a known fake thread_id into the seeded trial / application rows
 *      via getDatabase() so the handler's SQL queries match.
 *   3. Construct fake `oldThread` (archived=false) and `newThread`
 *      (archived=true) objects carrying that thread_id and a vi.fn() mock for
 *      setArchived.
 *   4. Call threadUpdateEvent.execute(oldThread, newThread).
 *   5. Assert that setArchived was called with false.
 *
 * Negative cases:
 *   - A thread_id not present in either table → setArchived is NOT called.
 *   - oldThread already archived (no state change) → handler returns early,
 *     setArchived is NOT called.
 *   - newThread not archived (no archive event) → handler returns early,
 *     setArchived is NOT called.
 *
 * Deferred
 * --------
 * The Discord .setArchived() call itself (live API) is deferred to manual
 * sandbox smoke tests — the unit mock is sufficient to confirm the handler
 * dispatches correctly without a real thread.
 *
 * Assertions
 * ----------
 * 1. setArchived(false) is called when a trial's thread_id is archived.
 * 2. setArchived(false) is called when an application's thread_id is archived.
 * 3. setArchived is NOT called for an unrelated thread_id.
 * 4. setArchived is NOT called when oldThread.archived is already true.
 * 5. setArchived is NOT called when newThread.archived is false.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetAndSeed } from '../setup/baseline.js';
import { queryOne } from '../setup/assertions.js';
import { getDatabase } from '../../../src/database/db.js';
import threadUpdateEvent from '../../../src/events/threadUpdate.js';
import type { TrialRow, ApplicationRow } from '../../../src/types/index.js';

// ---------------------------------------------------------------------------
// Fake thread factory
// ---------------------------------------------------------------------------

/** Minimal ThreadChannel-shaped object for threadUpdate tests. */
function fakeThread(id: string, archived: boolean) {
  return {
    id,
    archived,
    setArchived: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

/** Return the first trial row (any status). */
function getTrialRow(): TrialRow | undefined {
  return queryOne<TrialRow>('SELECT * FROM trials LIMIT 1');
}

/** Return the first application row. */
function getApplicationRow(): ApplicationRow | undefined {
  return queryOne<ApplicationRow>('SELECT * FROM applications LIMIT 1');
}

/** Patch a trial's thread_id in-place. */
function setTrialThreadId(trialId: number, threadId: string): void {
  getDatabase().prepare('UPDATE trials SET thread_id = ? WHERE id = ?').run(threadId, trialId);
}

/** Patch an application's thread_id (and forum_post_id) in-place. */
function setApplicationThreadId(appId: number, threadId: string): void {
  getDatabase()
    .prepare('UPDATE applications SET thread_id = ?, forum_post_id = ? WHERE id = ?')
    .run(threadId, threadId, appId);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('threadUpdate — thread keep-alive event handler', () => {
  beforeEach(async () => {
    await resetAndSeed({ discord: false });
  });

  // =========================================================================
  // 1. Trial thread gets re-opened when archived
  // =========================================================================

  it('calls setArchived(false) when a trial thread is archived', async () => {
    const trial = getTrialRow();
    expect(trial, 'a trial must exist after seed').toBeDefined();

    const THREAD_ID = '111111111111111111';
    setTrialThreadId(trial!.id, THREAD_ID);

    const oldThread = fakeThread(THREAD_ID, false);
    const newThread = fakeThread(THREAD_ID, true);

    await threadUpdateEvent.execute(oldThread, newThread);

    expect(newThread.setArchived).toHaveBeenCalledOnce();
    expect(newThread.setArchived).toHaveBeenCalledWith(false);
  });

  // =========================================================================
  // 2. Application thread gets re-opened when archived
  // =========================================================================

  it('calls setArchived(false) when an application thread is archived', async () => {
    const app = getApplicationRow();
    expect(app, 'an application must exist after seed').toBeDefined();

    // Make sure the application has an active-ish status recognised by the handler
    // ("in_progress", "submitted", "active"). The seeded app defaults to "submitted".
    const THREAD_ID = '222222222222222222';
    setApplicationThreadId(app!.id, THREAD_ID);

    const oldThread = fakeThread(THREAD_ID, false);
    const newThread = fakeThread(THREAD_ID, true);

    await threadUpdateEvent.execute(oldThread, newThread);

    expect(newThread.setArchived).toHaveBeenCalledOnce();
    expect(newThread.setArchived).toHaveBeenCalledWith(false);
  });

  // =========================================================================
  // 3. Unrelated thread_id → setArchived not called
  // =========================================================================

  it('does NOT call setArchived for a thread_id not in any active trial or application', async () => {
    const UNRELATED_ID = '999999999999999999';

    const oldThread = fakeThread(UNRELATED_ID, false);
    const newThread = fakeThread(UNRELATED_ID, true);

    await threadUpdateEvent.execute(oldThread, newThread);

    expect(newThread.setArchived).not.toHaveBeenCalled();
  });

  // =========================================================================
  // 4. oldThread already archived → handler returns early, no setArchived
  // =========================================================================

  it('does NOT call setArchived when oldThread was already archived', async () => {
    const trial = getTrialRow();
    expect(trial, 'a trial must exist after seed').toBeDefined();

    const THREAD_ID = '333333333333333333';
    setTrialThreadId(trial!.id, THREAD_ID);

    // Both old and new are archived — no state change to "just archived"
    const oldThread = fakeThread(THREAD_ID, true);
    const newThread = fakeThread(THREAD_ID, true);

    await threadUpdateEvent.execute(oldThread, newThread);

    expect(newThread.setArchived).not.toHaveBeenCalled();
  });

  // =========================================================================
  // 5. newThread not archived → no archive event, no setArchived
  // =========================================================================

  it('does NOT call setArchived when newThread is not archived', async () => {
    const trial = getTrialRow();
    expect(trial, 'a trial must exist after seed').toBeDefined();

    const THREAD_ID = '444444444444444444';
    setTrialThreadId(trial!.id, THREAD_ID);

    // Thread was un-archived (the reverse direction) — handler should skip
    const oldThread = fakeThread(THREAD_ID, true);
    const newThread = fakeThread(THREAD_ID, false);

    await threadUpdateEvent.execute(oldThread, newThread);

    expect(newThread.setArchived).not.toHaveBeenCalled();
  });
});

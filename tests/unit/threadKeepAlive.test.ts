import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../src/database/db.js';
import threadUpdateEvent from '../../src/events/threadUpdate.js';

vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** Minimal ThreadChannel-shaped object for threadUpdate tests. */
function fakeThread(id: string, archived: boolean, locked = false) {
  return {
    id,
    archived,
    locked,
    setArchived: vi.fn().mockResolvedValue(undefined),
  };
}

function seedActiveApplication(threadId: string): void {
  getDatabase()
    .prepare(
      "INSERT INTO applications (applicant_user_id, status, thread_id, forum_post_id) VALUES (?, 'active', ?, ?)",
    )
    .run('u1', threadId, threadId);
}

function seedActiveTrial(threadId: string): void {
  getDatabase()
    .prepare(
      "INSERT INTO trials (character_name, role, start_date, thread_id, status) VALUES (?, ?, ?, ?, 'active')",
    )
    .run('Rinn', 'Healer', '2026-06-20', threadId);
}

describe('threadUpdate keep-alive — locked threads stay closed', () => {
  beforeEach(() => {
    closeDatabase();
    initDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
  });

  // Sanity: an active thread Discord *auto*-archived (unlocked) is still rescued.
  it('re-opens an unlocked auto-archived application thread', async () => {
    const THREAD_ID = '101';
    seedActiveApplication(THREAD_ID);

    const newThread = fakeThread(THREAD_ID, true, false);
    await threadUpdateEvent.execute(fakeThread(THREAD_ID, false), newThread);

    expect(newThread.setArchived).toHaveBeenCalledWith(false);
  });

  it('re-opens an unlocked auto-archived trial thread', async () => {
    const THREAD_ID = '201';
    seedActiveTrial(THREAD_ID);

    const newThread = fakeThread(THREAD_ID, true, false);
    await threadUpdateEvent.execute(fakeThread(THREAD_ID, false), newThread);

    expect(newThread.setArchived).toHaveBeenCalledWith(false);
  });

  // The bug: closeThread() locks + archives in one edit. The resolution flow
  // updates the DB status *after* closing, so the row still reads 'active' when
  // the threadUpdate fires — but the lock marks it as a deliberate close, so the
  // keep-alive must leave it closed.
  it('does NOT re-open a locked + archived application thread (deliberate close)', async () => {
    const THREAD_ID = '102';
    seedActiveApplication(THREAD_ID);

    const newThread = fakeThread(THREAD_ID, true, true);
    await threadUpdateEvent.execute(fakeThread(THREAD_ID, false), newThread);

    expect(newThread.setArchived).not.toHaveBeenCalled();
  });

  it('does NOT re-open a locked + archived trial thread (deliberate close)', async () => {
    const THREAD_ID = '202';
    seedActiveTrial(THREAD_ID);

    const newThread = fakeThread(THREAD_ID, true, true);
    await threadUpdateEvent.execute(fakeThread(THREAD_ID, false), newThread);

    expect(newThread.setArchived).not.toHaveBeenCalled();
  });
});

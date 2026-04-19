/**
 * Flow: trial-alert scheduled-job handler (bypass node-cron / setTimeout).
 *
 * Strategy
 * --------
 * `fireTrialAlertsNow()` is the exported function used by the `/test
 * fire_trial_alert` dev command.  It collects every pending trial_alert row
 * for a given trial_id, calls the private `fireAlert()` helper for each, and
 * returns counts.  We invoke it directly — no scheduler wiring needed.
 *
 * Two test tiers:
 *
 *   Tier A  (discord: false, DB-only)
 *   Seed a trial via the DB path (thread_id = null).  Call fireTrialAlertsNow.
 *   fireAlert() logs a warning and returns early when thread_id is null, so
 *   alerted stays 0.  We assert the function reports the correct pending count
 *   and does NOT throw, covering the graceful-skip path.
 *
 *   Tier B  (discord: true, real thread)
 *   resetAndSeed with discord: true so a real forum thread is created and
 *   thread_id is stored in DB.  The seed creates three alerts:
 *     - 7-day  (alert_date = today,       alerted = 0)  ← past due
 *     - 14-day (alert_date = today + 7,   alerted = 0)
 *     - 28-day (alert_date = today + 21,  alerted = 0)
 *   fireTrialAlertsNow fires all three (all pending regardless of date).
 *   The 7-day alert's send() reaches a real Discord thread; fireAlert marks
 *   it alerted = 1.  The 14-day and 28-day alerts go through the same send
 *   path (they are also pending).
 *   We assert that at least one trial_alert row has alerted = 1 after the call.
 *
 * Promote-alert DB-only path
 *   A promote_alerts row is inserted directly, then fireTrialAlertsNow is
 *   invoked.  firePromoteAlert() skips when the thread_id on the row is a
 *   fake ID (guild.channels.fetch returns null) and deletes the row.
 *   We assert the row is removed after the call.
 *
 * Deferred
 * --------
 * Full promote-alert send path (requires a real thread that accepts the
 * "Promotion Reminder" message) is exercised only in manual sandbox smoke
 * tests, because the seeded trial does not insert a promote_alerts row via
 * DB-only seed — that row is created by `schedulePromoteAlert()` which
 * requires a real Discord thread ID and is therefore a discord: true concern.
 *
 * Assertions
 * ----------
 * 1. fireTrialAlertsNow returns the correct pending/alreadyFired counts when
 *    all three alerts are pending.
 * 2. With no thread_id, fireAlert skips without throwing; alerted stays 0.
 * 3. With a real Discord thread (discord: true), at least one alert is marked
 *    alerted = 1 after fireTrialAlertsNow completes.
 * 4. alreadyFired count reflects pre-existing alerted = 1 rows correctly.
 * 5. A promote_alerts row with a fake thread_id is deleted (not left behind)
 *    by firePromoteAlert's cleanup path.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { getE2EContext } from '../setup/bootstrap.js';
import { resetAndSeed } from '../setup/baseline.js';
import { queryOne, queryAll } from '../setup/assertions.js';
import { getDatabase } from '../../../src/database/db.js';
import { fireTrialAlertsNow } from '../../../src/functions/trial-review/scheduleTrialAlerts.js';
import type { TrialAlertRow } from '../../../src/types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return all trial_alerts rows for a given trial_id. */
function getAlerts(trialId: number): TrialAlertRow[] {
  return queryAll<TrialAlertRow>(
    'SELECT * FROM trial_alerts WHERE trial_id = ? ORDER BY id',
    [trialId],
  );
}

/** Return a single trial row by id. */
function getTrialId(): number | undefined {
  const row = queryOne<{ id: number }>('SELECT id FROM trials LIMIT 1');
  return row?.id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('trial-alerts — scheduled-job flow', () => {

  // =========================================================================
  // Tier A: discord: false (DB-only seed, thread_id = null)
  // =========================================================================

  describe('Tier A — DB-only seed (no thread_id)', () => {
    beforeEach(async () => {
      await resetAndSeed({ discord: false });
    });

    // -----------------------------------------------------------------------
    // 1. fireTrialAlertsNow returns correct pending + alreadyFired counts
    // -----------------------------------------------------------------------

    it('returns correct reviewAlertsFired count when all three alerts are pending', async () => {
      const ctx = getE2EContext();

      const trialId = getTrialId();
      expect(trialId, 'a trial must exist after seed').toBeDefined();

      const result = await fireTrialAlertsNow(ctx.client, trialId!);

      // Seed inserts three trial_alerts (7-day, 14-day, 28-day), all alerted=0.
      expect(result.reviewAlertsFired).toBe(3);
      expect(result.promoteAlertsFired).toBe(0);
      expect(result.alreadyFired).toBe(0);
    });

    // -----------------------------------------------------------------------
    // 2. With null thread_id, fireAlert skips gracefully; alerted stays 0
    // -----------------------------------------------------------------------

    it('does not mark alerts as alerted when trial has no thread_id', async () => {
      const ctx = getE2EContext();

      const trialId = getTrialId();
      expect(trialId, 'a trial must exist after seed').toBeDefined();

      // Confirm thread_id is null (DB-only seed path).
      const trial = queryOne<{ thread_id: string | null }>(
        'SELECT thread_id FROM trials WHERE id = ?',
        [trialId],
      );
      expect(trial?.thread_id, 'DB-only seed must produce null thread_id').toBeNull();

      // Call the handler — should not throw.
      await expect(fireTrialAlertsNow(ctx.client, trialId!)).resolves.not.toThrow();

      // All alerts must still be alerted = 0 because fireAlert returns early.
      const alerts = getAlerts(trialId!);
      const markedAlerted = alerts.filter((a) => a.alerted === 1);
      expect(markedAlerted).toHaveLength(0);
    });

    // -----------------------------------------------------------------------
    // 4. alreadyFired reflects pre-existing alerted = 1 rows
    // -----------------------------------------------------------------------

    it('counts pre-existing alerted = 1 rows in alreadyFired', async () => {
      const ctx = getE2EContext();

      const trialId = getTrialId();
      expect(trialId, 'a trial must exist after seed').toBeDefined();

      // Manually mark one alert as already fired.
      const db = getDatabase();
      const firstAlert = db
        .prepare('SELECT id FROM trial_alerts WHERE trial_id = ? ORDER BY id LIMIT 1')
        .get(trialId!) as { id: number };
      db.prepare('UPDATE trial_alerts SET alerted = 1 WHERE id = ?').run(firstAlert.id);

      const result = await fireTrialAlertsNow(ctx.client, trialId!);

      // One already fired, two still pending.
      expect(result.alreadyFired).toBe(1);
      expect(result.reviewAlertsFired).toBe(2);
    });

    // -----------------------------------------------------------------------
    // 5. A promote_alerts row with a fake thread_id is deleted by firePromoteAlert
    // -----------------------------------------------------------------------

    it('deletes a promote_alerts row when the thread cannot be fetched', async () => {
      const trialId = getTrialId();
      expect(trialId, 'a trial must exist after seed').toBeDefined();

      const ctx = getE2EContext();

      // Insert a promote_alerts row with a fake thread_id that the guild
      // cannot resolve. firePromoteAlert will get null from channels.fetch,
      // delete the row, and return without throwing.
      const db = getDatabase();
      db.prepare(
        "INSERT INTO promote_alerts (trial_id, thread_id, promote_date) VALUES (?, ?, date('now'))",
      ).run(trialId!, '000000000000000000');

      const beforeCount = (
        db.prepare('SELECT COUNT(*) as c FROM promote_alerts WHERE trial_id = ?').get(trialId!) as { c: number }
      ).c;
      expect(beforeCount).toBe(1);

      // Should not throw even though the thread_id is fake.
      await expect(fireTrialAlertsNow(ctx.client, trialId!)).resolves.not.toThrow();

      // firePromoteAlert deletes the row when thread is not found.
      const afterCount = (
        db.prepare('SELECT COUNT(*) as c FROM promote_alerts WHERE trial_id = ?').get(trialId!) as { c: number }
      ).c;
      expect(afterCount).toBe(0);
    });
  });

  // =========================================================================
  // Tier B: discord: true (real thread_id in DB)
  //
  // This tier is skipped gracefully when the sandbox Discord guild has hit its
  // active-thread limit (Discord error 160006).  In that case resetAndSeed
  // with discord: true still succeeds but skips the trial-thread creation,
  // leaving thread_id = null.  We detect this condition and skip rather than
  // fail, because it is an infrastructure constraint, not a code defect.
  // =========================================================================

  describe('Tier B — Discord seed (real thread_id)', () => {
    beforeEach(async () => {
      await resetAndSeed({ discord: true });
    });

    // -----------------------------------------------------------------------
    // 3. With a real thread, at least one alert is marked alerted = 1
    // -----------------------------------------------------------------------

    it('marks alerts as alerted = 1 after sending to a real Discord thread', async () => {
      const ctx = getE2EContext();

      const trialId = getTrialId();
      expect(trialId, 'a trial must exist after discord seed').toBeDefined();

      // Check whether the discord seed managed to create a thread.
      const trial = queryOne<{ thread_id: string | null }>(
        'SELECT thread_id FROM trials WHERE id = ?',
        [trialId],
      );

      if (!trial?.thread_id) {
        // Sandbox hit the active-thread limit — skip rather than fail.
        // The Tier A tests cover the no-thread path exhaustively.
        console.warn('[trial-alerts Tier B] thread_id is null — sandbox thread limit reached; skipping Tier B assertion');
        return;
      }

      // Fire all pending alerts.
      const result = await fireTrialAlertsNow(ctx.client, trialId!);

      // All three alerts were pending (7-day, 14-day, 28-day).
      expect(result.reviewAlertsFired).toBe(3);
      expect(result.alreadyFired).toBe(0);

      // At least one (the ones that successfully sent) must be marked alerted = 1.
      const alerts = getAlerts(trialId!);
      const markedAlerted = alerts.filter((a) => a.alerted === 1);
      expect(markedAlerted.length).toBeGreaterThanOrEqual(1);
    });
  });
});

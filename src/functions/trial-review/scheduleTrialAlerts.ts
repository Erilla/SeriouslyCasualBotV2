import type { Client, TextChannel } from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';
import type { TrialAlertRow, TrialRow, PromoteAlertRow } from '../../types/index.js';

// ─── Constants ──────────────────────────────────────────────

// setTimeout max safe delay is 2^31-1 ms (~24.85 days).
// Delays exceeding this overflow to 0 and fire immediately.
const MAX_TIMEOUT_MS = 2_147_483_647;

// ─── Timer Storage ───────────────────────────────────────────

const alertTimers = new Map<number, NodeJS.Timeout>();
const promoteTimers = new Map<number, NodeJS.Timeout>();

/**
 * Schedule a callback with a delay that may exceed setTimeout's 2^31-1 ms limit.
 * If the delay is larger, it chains intermediate timeouts.
 */
function safeSetTimeout(callback: () => void, delay: number): NodeJS.Timeout {
  if (delay <= MAX_TIMEOUT_MS) {
    return setTimeout(callback, delay);
  }
  // Chain: wait MAX_TIMEOUT_MS, then re-check remaining delay
  return setTimeout(() => {
    const remaining = delay - MAX_TIMEOUT_MS;
    if (remaining <= 0) {
      callback();
    } else {
      safeSetTimeout(callback, remaining);
    }
  }, MAX_TIMEOUT_MS);
}

/**
 * Clear all scheduled timers. Call on shutdown.
 */
export function clearAllTimers(): void {
  for (const timer of alertTimers.values()) {
    clearTimeout(timer);
  }
  alertTimers.clear();

  for (const timer of promoteTimers.values()) {
    clearTimeout(timer);
  }
  promoteTimers.clear();

  logger.debug('Trials', 'Cleared all trial alert timers');
}

// ─── Alert Firing ────────────────────────────────────────────

async function fireAlert(client: Client, alert: TrialAlertRow): Promise<void> {
  const db = getDatabase();

  const trial = db
    .prepare('SELECT * FROM trials WHERE id = ?')
    .get(alert.trial_id) as TrialRow | undefined;

  if (!trial || trial.status !== 'active') {
    logger.debug('Trials', `Skipping alert #${alert.id} - trial inactive or missing`);
    return;
  }

  if (!trial.thread_id) {
    logger.warn('Trials', `Trial #${trial.id} has no thread_id, cannot send alert`);
    return;
  }

  const alertLabel = alert.alert_name.replace('_', '-');

  try {
    const guild = client.guilds.cache.first();
    if (!guild) return;

    const thread = await guild.channels.fetch(trial.thread_id) as TextChannel | null;
    if (!thread) {
      logger.warn('Trials', `Thread ${trial.thread_id} not found for trial #${trial.id}`);
      return;
    }

    await thread.send(
      `**${alertLabel} Review Alert**\n` +
      `It's time for the ${alertLabel} review of **${trial.character_name}**.\n` +
      `Please discuss their progress and decide on next steps.`,
    );

    logger.info('Trials', `Fired ${alert.alert_name} alert for trial #${trial.id} (${trial.character_name})`);
  } catch (error) {
    logger.error(
      'Trials',
      `Failed to send alert for trial #${trial.id}: ${error}`,
      error as Error,
    );
  }

  // Mark as alerted
  db.prepare('UPDATE trial_alerts SET alerted = 1 WHERE id = ?').run(alert.id);
  alertTimers.delete(alert.id);
}

async function firePromoteAlert(
  client: Client,
  promoteAlert: PromoteAlertRow,
): Promise<void> {
  const db = getDatabase();

  const trial = db
    .prepare('SELECT * FROM trials WHERE id = ?')
    .get(promoteAlert.trial_id) as TrialRow | undefined;

  if (!trial) {
    logger.debug('Trials', `Skipping promote alert #${promoteAlert.id} - trial missing`);
    db.prepare('DELETE FROM promote_alerts WHERE id = ?').run(promoteAlert.id);
    return;
  }

  try {
    const guild = client.guilds.cache.first();
    if (!guild) return;

    const thread = await guild.channels.fetch(promoteAlert.thread_id) as TextChannel | null;
    if (!thread) {
      logger.warn('Trials', `Thread ${promoteAlert.thread_id} not found for promote alert`);
      db.prepare('DELETE FROM promote_alerts WHERE id = ?').run(promoteAlert.id);
      return;
    }

    await thread.send(
      `**Promotion Reminder**\n` +
      `**${trial.character_name}** was marked for promotion and is due for promotion today.\n` +
      `Please promote them in-game and close this trial.`,
    );

    logger.info('Trials', `Fired promote alert for trial #${trial.id} (${trial.character_name})`);
  } catch (error) {
    logger.error(
      'Trials',
      `Failed to send promote alert for trial #${trial.id}: ${error}`,
      error as Error,
    );
  }

  // Delete the promote alert record
  db.prepare('DELETE FROM promote_alerts WHERE id = ?').run(promoteAlert.id);
  promoteTimers.delete(promoteAlert.id);
}

// ─── Manual Trigger (test/dev) ───────────────────────────────

/**
 * Fire every pending (alerted = 0) alert for a trial immediately, bypassing
 * the scheduled timers. Used by the dev-only `/test fire_trial_alert` command
 * so the 7/14/28-day review flow can be verified without waiting days.
 *
 * Returns the count of alerts that were fired and of those still pending,
 * so the caller can report a meaningful status back to the invoker.
 */
export async function fireTrialAlertsNow(
  client: Client,
  trialId: number,
): Promise<{ fired: number; alreadyFired: number }> {
  const db = getDatabase();

  const pending = db
    .prepare('SELECT * FROM trial_alerts WHERE trial_id = ? AND alerted = 0')
    .all(trialId) as TrialAlertRow[];
  const alreadyFired = (
    db
      .prepare('SELECT COUNT(*) as c FROM trial_alerts WHERE trial_id = ? AND alerted = 1')
      .get(trialId) as { c: number }
  ).c;

  for (const alert of pending) {
    const existing = alertTimers.get(alert.id);
    if (existing) {
      clearTimeout(existing);
      alertTimers.delete(alert.id);
    }
    await fireAlert(client, alert);
  }

  return { fired: pending.length, alreadyFired };
}

// ─── Schedule Individual Trial Alerts ────────────────────────

/**
 * Schedule pending alerts for a single trial.
 */
export function scheduleTrialAlerts(client: Client, trialId: number): void {
  const db = getDatabase();

  const alerts = db
    .prepare('SELECT * FROM trial_alerts WHERE trial_id = ? AND alerted = 0')
    .all(trialId) as TrialAlertRow[];

  const now = Date.now();

  for (const alert of alerts) {
    // Clear existing timer if any
    const existing = alertTimers.get(alert.id);
    if (existing) clearTimeout(existing);

    const alertTime = new Date(alert.alert_date + 'T12:00:00Z').getTime();
    const delay = Math.max(0, alertTime - now);

    if (delay === 0) {
      // Past due - fire immediately (async, don't await)
      void fireAlert(client, alert);
    } else {
      const timer = safeSetTimeout(() => {
        void fireAlert(client, alert);
      }, delay);
      alertTimers.set(alert.id, timer);
    }
  }

  if (alerts.length > 0) {
    logger.debug('Trials', `Scheduled ${alerts.length} alerts for trial #${trialId}`);
  }
}

// ─── Reschedule All Alerts (Startup) ─────────────────────────

/**
 * Reschedule all pending alerts. Called on bot startup.
 */
export function rescheduleAllAlerts(client: Client): void {
  const db = getDatabase();

  // Reschedule trial alerts
  const alerts = db
    .prepare('SELECT * FROM trial_alerts WHERE alerted = 0')
    .all() as TrialAlertRow[];

  const now = Date.now();
  let pastDue = 0;
  let scheduled = 0;

  for (const alert of alerts) {
    const alertTime = new Date(alert.alert_date + 'T12:00:00Z').getTime();
    const delay = alertTime - now;

    if (delay <= 0) {
      pastDue++;
      void fireAlert(client, alert);
    } else {
      scheduled++;
      const timer = safeSetTimeout(() => {
        void fireAlert(client, alert);
      }, delay);
      alertTimers.set(alert.id, timer);
    }
  }

  // Reschedule promote alerts
  const promoteAlerts = db
    .prepare('SELECT * FROM promote_alerts')
    .all() as PromoteAlertRow[];

  let promotePastDue = 0;
  let promoteScheduled = 0;

  for (const pa of promoteAlerts) {
    const promoteTime = new Date(pa.promote_date + 'T12:00:00Z').getTime();
    const delay = promoteTime - now;

    if (delay <= 0) {
      promotePastDue++;
      void firePromoteAlert(client, pa);
    } else {
      promoteScheduled++;
      const timer = safeSetTimeout(() => {
        void firePromoteAlert(client, pa);
      }, delay);
      promoteTimers.set(pa.id, timer);
    }
  }

  logger.info(
    'Trials',
    `Rescheduled alerts: ${pastDue} past-due, ${scheduled} scheduled, ` +
    `${promotePastDue} promote past-due, ${promoteScheduled} promote scheduled`,
  );
}

// ─── Schedule Promote Alert ──────────────────────────────────

/**
 * Schedule a promotion alert for a trial.
 */
export function schedulePromoteAlert(
  client: Client,
  trialId: number,
  threadId: string,
  promoteDate: string,
): void {
  const db = getDatabase();

  const result = db
    .prepare(
      'INSERT INTO promote_alerts (trial_id, thread_id, promote_date) VALUES (?, ?, ?)',
    )
    .run(trialId, threadId, promoteDate);

  const promoteAlertId = result.lastInsertRowid as number;
  const now = Date.now();
  const promoteTime = new Date(promoteDate + 'T12:00:00Z').getTime();
  const delay = promoteTime - now;

  const promoteAlert = db
    .prepare('SELECT * FROM promote_alerts WHERE id = ?')
    .get(promoteAlertId) as PromoteAlertRow;

  if (delay <= 0) {
    void firePromoteAlert(client, promoteAlert);
  } else {
    const timer = safeSetTimeout(() => {
      void firePromoteAlert(client, promoteAlert);
    }, delay);
    promoteTimers.set(promoteAlertId, timer);
  }

  logger.info(
    'Trials',
    `Scheduled promote alert for trial #${trialId} on ${promoteDate}`,
  );
}

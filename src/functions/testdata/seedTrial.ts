import type Database from 'better-sqlite3';

export interface SeedTrialResult {
  trialId: number;
  alertCount: number;
}

/**
 * Seeds 1 mock trial with start_date 7 days ago and 3 trial alerts:
 *   - 7-day  (today, alerted=0)
 *   - 14-day (7 days from now)
 *   - 28-day (21 days from now)
 */
export function seedTrial(db: Database.Database): SeedTrialResult {
  const tx = db.transaction((): SeedTrialResult => {
    // start_date is 7 days ago
    const trialResult = db.prepare(`
      INSERT INTO trials (character_name, role, start_date, status)
      VALUES (?, ?, date('now', '-7 days'), 'active')
    `).run('Testcharacter', 'DPS');

    const trialId = trialResult.lastInsertRowid as number;

    // Compute alert dates in JS to store real date strings
    const now = new Date();
    const addDays = (d: Date, days: number): string => {
      const result = new Date(d);
      result.setUTCDate(result.getUTCDate() + days);
      return result.toISOString().slice(0, 10);
    };

    const insertAlert = db.prepare(`
      INSERT INTO trial_alerts (trial_id, alert_name, alert_date, alerted) VALUES (?, ?, ?, ?)
    `);

    // 7-day alert: start + 7 days = today
    insertAlert.run(trialId, '7-day review',  addDays(now, 0),  0);
    // 14-day alert: start + 14 days = 7 days from now
    insertAlert.run(trialId, '14-day review', addDays(now, 7),  0);
    // 28-day alert: start + 28 days = 21 days from now
    insertAlert.run(trialId, '28-day review', addDays(now, 21), 0);

    return { trialId, alertCount: 3 };
  });

  return tx();
}

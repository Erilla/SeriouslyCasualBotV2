import type Database from 'better-sqlite3';

export interface SeedTrialOptions {
  characterName?: string;
  role?: string;
  applicationId?: number;
}

export interface SeedTrialResult {
  trialId: number;
  alertCount: number;
}

/**
 * Seeds 1 mock trial with start_date 7 days ago and 3 trial alerts:
 *   - 7-day  (today, alerted=0)
 *   - 14-day (7 days from now)
 *   - 28-day (21 days from now)
 * Optionally links to an application via applicationId.
 */
export function seedTrial(db: Database.Database, options: SeedTrialOptions = {}): SeedTrialResult {
  const characterName = options.characterName ?? 'Testcharacter';
  const role = options.role ?? 'DPS';
  const applicationId = options.applicationId ?? null;

  const tx = db.transaction((): SeedTrialResult => {
    const trialResult = db.prepare(`
      INSERT INTO trials (character_name, role, start_date, status, application_id)
      VALUES (?, ?, date('now', '-7 days'), 'active', ?)
    `).run(characterName, role, applicationId);

    const trialId = trialResult.lastInsertRowid as number;

    const now = new Date();
    const addDays = (d: Date, days: number): string => {
      const result = new Date(d);
      result.setUTCDate(result.getUTCDate() + days);
      return result.toISOString().slice(0, 10);
    };

    const insertAlert = db.prepare(`
      INSERT INTO trial_alerts (trial_id, alert_name, alert_date, alerted) VALUES (?, ?, ?, ?)
    `);

    insertAlert.run(trialId, '7-day review',  addDays(now, 0),  0);
    insertAlert.run(trialId, '14-day review', addDays(now, 7),  0);
    insertAlert.run(trialId, '28-day review', addDays(now, 21), 0);

    return { trialId, alertCount: 3 };
  });

  return tx();
}

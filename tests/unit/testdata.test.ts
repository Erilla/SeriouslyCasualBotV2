import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createTables } from '../../src/database/schema.js';
import { seedDatabase } from '../../src/database/seed.js';
import { seedRaiders } from '../../src/functions/testdata/seedRaiders.js';
import { seedApplication } from '../../src/functions/testdata/seedApplication.js';
import { seedApplicationQuestions } from '../../src/functions/testdata/seedApplicationQuestions.js';
import { seedApplicationVariety } from '../../src/functions/testdata/seedApplicationVariety.js';
import { seedTrial } from '../../src/functions/testdata/seedTrial.js';
import { seedEpgp } from '../../src/functions/testdata/seedEpgp.js';
import { seedLoot } from '../../src/functions/testdata/seedLoot.js';
import { resetData } from '../../src/functions/testdata/resetData.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  createTables(db);
});

afterEach(() => {
  db.close();
});

// ─── seedRaiders ─────────────────────────────────────────────────────────────

describe('seedRaiders', () => {
  it('inserts 15 mock raiders into the database', () => {
    seedRaiders(db);

    const rows = db.prepare('SELECT * FROM raiders').all() as Array<{
      character_name: string;
      realm: string;
      region: string;
      rank: number;
      class: string;
    }>;

    expect(rows).toHaveLength(15);
  });

  it('raiders have varied realms', () => {
    seedRaiders(db);

    const rows = db.prepare('SELECT DISTINCT realm FROM raiders').all() as Array<{ realm: string }>;
    const realms = rows.map((r) => r.realm);

    expect(realms.length).toBeGreaterThan(1);
  });

  it('raiders have varied classes', () => {
    seedRaiders(db);

    const rows = db.prepare('SELECT DISTINCT class FROM raiders').all() as Array<{ class: string }>;
    const classes = rows.map((r) => r.class);

    expect(classes.length).toBeGreaterThan(1);
  });

  it('at least one raider has a special character in their name', () => {
    seedRaiders(db);

    const rows = db.prepare('SELECT character_name FROM raiders').all() as Array<{
      character_name: string;
    }>;

    const hasSpecialChar = rows.some((r) => /[àáâãäåæçèéêëìíîïðñòóôõöùúûüýþÿ']/i.test(r.character_name));
    expect(hasSpecialChar).toBe(true);
  });

  it('is idempotent — calling twice does not duplicate raiders', () => {
    seedRaiders(db);
    seedRaiders(db);

    const rows = db.prepare('SELECT * FROM raiders').all();
    expect(rows).toHaveLength(15);
  });

  it('all raiders have valid rank, realm, and region', () => {
    seedRaiders(db);

    const rows = db.prepare('SELECT * FROM raiders').all() as Array<{
      character_name: string;
      realm: string;
      region: string;
      rank: number;
      class: string;
    }>;

    for (const row of rows) {
      expect(row.realm).toBeTruthy();
      expect(row.region).toBeTruthy();
      expect(typeof row.rank).toBe('number');
      expect(row.class).toBeTruthy();
    }
  });
});

// ─── seedApplicationQuestions ────────────────────────────────────────────────

describe('seedApplicationQuestions', () => {
  it('inserts the 9 default questions when table is empty', () => {
    const result = seedApplicationQuestions(db);
    expect(result.inserted).toBe(9);

    const count = (db.prepare('SELECT COUNT(*) as count FROM application_questions').get() as { count: number }).count;
    expect(count).toBe(9);
  });

  it('is idempotent — does not insert again when questions already exist', () => {
    seedApplicationQuestions(db);
    const second = seedApplicationQuestions(db);

    expect(second.inserted).toBe(0);
    const count = (db.prepare('SELECT COUNT(*) as count FROM application_questions').get() as { count: number }).count;
    expect(count).toBe(9);
  });

  it('questions are ordered by sort_order starting at 1', () => {
    seedApplicationQuestions(db);
    const rows = db.prepare('SELECT sort_order FROM application_questions ORDER BY sort_order').all() as Array<{ sort_order: number }>;
    expect(rows.map((r) => r.sort_order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

// ─── seedApplication ─────────────────────────────────────────────────────────

describe('seedApplication', () => {
  it('inserts 1 application with status submitted', () => {
    const result = seedApplication(db);

    const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(result.applicationId) as {
      status: string;
      character_name: string;
    };

    expect(app).toBeDefined();
    expect(app.status).toBe('submitted');
    expect(app.character_name).toBe('Testcharacter');
  });

  it('returns the applicationId and questionCount', () => {
    const result = seedApplication(db);

    expect(typeof result.applicationId).toBe('number');
    expect(result.applicationId).toBeGreaterThan(0);
    expect(result.questionCount).toBeGreaterThan(0);
  });

  it('inserts default questions when none exist', () => {
    seedApplication(db);

    const count = (db.prepare('SELECT COUNT(*) as count FROM application_questions').get() as { count: number }).count;
    expect(count).toBe(9);
  });

  it('inserts one answer per question', () => {
    const result = seedApplication(db);

    const answers = db.prepare('SELECT * FROM application_answers WHERE application_id = ?').all(result.applicationId);
    expect(answers).toHaveLength(result.questionCount);
  });

  it('inserts 2 votes for the application', () => {
    const result = seedApplication(db);

    const votes = db.prepare('SELECT * FROM application_votes WHERE application_id = ?').all(result.applicationId) as Array<{
      vote_type: string;
    }>;

    expect(votes).toHaveLength(2);
    const types = votes.map((v) => v.vote_type);
    expect(types).toContain('for');
    expect(types).toContain('neutral');
  });

  it('does not re-insert questions when they already exist', () => {
    seedApplication(db);
    seedApplication(db);

    const count = (db.prepare('SELECT COUNT(*) as count FROM application_questions').get() as { count: number }).count;
    expect(count).toBe(9);
  });

  it('creates a second application without error when questions already exist', () => {
    const r1 = seedApplication(db);
    const r2 = seedApplication(db);

    expect(r2.applicationId).toBeGreaterThan(r1.applicationId);
  });

  it('respects options.characterName, options.userId, and options.status', () => {
    const result = seedApplication(db, {
      characterName: 'CustomChar',
      userId: 'custom-user-id',
      status: 'accepted',
    });

    const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(result.applicationId) as {
      character_name: string;
      applicant_user_id: string;
      status: string;
    };
    expect(app.character_name).toBe('CustomChar');
    expect(app.applicant_user_id).toBe('custom-user-id');
    expect(app.status).toBe('accepted');
  });

  it('respects options.answerCount for partial answer lists', () => {
    const result = seedApplication(db, { answerCount: 3 });
    expect(result.answersInserted).toBe(3);

    const answers = db.prepare('SELECT * FROM application_answers WHERE application_id = ?').all(result.applicationId);
    expect(answers).toHaveLength(3);
  });

  it('skips votes for in_progress status by default', () => {
    const result = seedApplication(db, { status: 'in_progress', answerCount: 2 });
    expect(result.votesInserted).toBe(0);

    const votes = db.prepare('SELECT * FROM application_votes WHERE application_id = ?').all(result.applicationId);
    expect(votes).toHaveLength(0);
  });

  it('skips votes for abandoned status by default', () => {
    const result = seedApplication(db, { status: 'abandoned' });
    expect(result.votesInserted).toBe(0);
  });
});

// ─── seedApplicationVariety ──────────────────────────────────────────────────

describe('seedApplicationVariety', () => {
  it('inserts 5 applications, one per status', () => {
    const result = seedApplicationVariety(db);

    expect(result.applicationIds).toHaveLength(5);

    const rows = db.prepare('SELECT status, COUNT(*) as count FROM applications GROUP BY status').all() as Array<{ status: string; count: number }>;
    const byStatus = Object.fromEntries(rows.map((r) => [r.status, r.count]));

    expect(byStatus.in_progress).toBe(1);
    expect(byStatus.submitted).toBe(1);
    expect(byStatus.accepted).toBe(1);
    expect(byStatus.rejected).toBe(1);
    expect(byStatus.abandoned).toBe(1);
  });

  it('in_progress application has 3 answers and 0 votes', () => {
    seedApplicationVariety(db);

    const app = db.prepare("SELECT id FROM applications WHERE status = 'in_progress'").get() as { id: number };
    const answers = db.prepare('SELECT * FROM application_answers WHERE application_id = ?').all(app.id);
    const votes = db.prepare('SELECT * FROM application_votes WHERE application_id = ?').all(app.id);

    expect(answers).toHaveLength(3);
    expect(votes).toHaveLength(0);
  });

  it('abandoned application has 0 votes', () => {
    seedApplicationVariety(db);

    const app = db.prepare("SELECT id FROM applications WHERE status = 'abandoned'").get() as { id: number };
    const votes = db.prepare('SELECT * FROM application_votes WHERE application_id = ?').all(app.id);
    expect(votes).toHaveLength(0);
  });
});

// ─── seedTrial ────────────────────────────────────────────────────────────────

describe('seedTrial', () => {
  it('inserts 1 active trial', () => {
    const result = seedTrial(db);

    const trial = db.prepare('SELECT * FROM trials WHERE id = ?').get(result.trialId) as {
      status: string;
      role: string;
      character_name: string;
      start_date: string;
    };

    expect(trial).toBeDefined();
    expect(trial.status).toBe('active');
    expect(trial.role).toBe('DPS');
    expect(trial.character_name).toBe('Testcharacter');
  });

  it('returns trialId and alertCount of 3', () => {
    const result = seedTrial(db);

    expect(typeof result.trialId).toBe('number');
    expect(result.trialId).toBeGreaterThan(0);
    expect(result.alertCount).toBe(3);
  });

  it('inserts 3 trial alerts for the trial', () => {
    const result = seedTrial(db);

    const alerts = db.prepare('SELECT * FROM trial_alerts WHERE trial_id = ?').all(result.trialId) as Array<{
      alert_name: string;
      alert_date: string;
      alerted: number;
    }>;

    expect(alerts).toHaveLength(3);
  });

  it('alert names are 7-day, 14-day, and 28-day review', () => {
    const result = seedTrial(db);

    const alerts = db.prepare('SELECT alert_name FROM trial_alerts WHERE trial_id = ? ORDER BY alert_date').all(result.trialId) as Array<{ alert_name: string }>;
    const names = alerts.map((a) => a.alert_name);

    expect(names).toContain('7-day review');
    expect(names).toContain('14-day review');
    expect(names).toContain('28-day review');
  });

  it('all alerts start with alerted = 0', () => {
    const result = seedTrial(db);

    const alerts = db.prepare('SELECT alerted FROM trial_alerts WHERE trial_id = ?').all(result.trialId) as Array<{ alerted: number }>;

    for (const alert of alerts) {
      expect(alert.alerted).toBe(0);
    }
  });

  it('trial start_date is 7 days ago', () => {
    const result = seedTrial(db);

    const trial = db.prepare('SELECT start_date FROM trials WHERE id = ?').get(result.trialId) as { start_date: string };

    const startDate = new Date(trial.start_date);
    const expected = new Date();
    expected.setUTCDate(expected.getUTCDate() - 7);

    // Allow 1 day of tolerance
    const diffDays = Math.abs((expected.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
    expect(diffDays).toBeLessThan(1.5);
  });

  it('14-day and 28-day alerts are in the future', () => {
    const result = seedTrial(db);

    const alerts = db.prepare('SELECT alert_name, alert_date FROM trial_alerts WHERE trial_id = ?').all(result.trialId) as Array<{
      alert_name: string;
      alert_date: string;
    }>;

    const today = new Date().toISOString().slice(0, 10);
    const futureAlerts = alerts.filter((a) => a.alert_name !== '7-day review');

    for (const alert of futureAlerts) {
      expect(alert.alert_date > today).toBe(true);
    }
  });

  it('stores application_id when provided', () => {
    const appResult = seedApplication(db, { status: 'accepted' });

    const trialResult = seedTrial(db, { applicationId: appResult.applicationId });

    const trial = db.prepare('SELECT application_id FROM trials WHERE id = ?').get(trialResult.trialId) as { application_id: number };
    expect(trial.application_id).toBe(appResult.applicationId);
  });

  it('application_id is NULL when not provided', () => {
    const result = seedTrial(db);

    const trial = db.prepare('SELECT application_id FROM trials WHERE id = ?').get(result.trialId) as { application_id: number | null };
    expect(trial.application_id).toBeNull();
  });
});

// ─── seedEpgp ────────────────────────────────────────────────────────────────

describe('seedEpgp', () => {
  beforeEach(() => {
    seedRaiders(db);
  });

  it('throws if no raiders exist', () => {
    const emptyDb = new Database(':memory:');
    createTables(emptyDb);
    expect(() => seedEpgp(emptyDb)).toThrow('No raiders found');
    emptyDb.close();
  });

  it('returns a result object with counts', () => {
    const result = seedEpgp(db);

    expect(result.raiderCount).toBe(15);
    expect(result.effortPointsInserted).toBe(45); // 15 raiders × 3 weeks
    expect(result.gearPointsInserted).toBeGreaterThan(0);
    expect(result.lootHistoryInserted).toBe(5);
    expect(result.uploadHistoryInserted).toBe(1);
  });

  it('inserts 3 EP entries per raider', () => {
    seedEpgp(db);

    const total = (db.prepare('SELECT COUNT(*) as count FROM epgp_effort_points').get() as { count: number }).count;
    expect(total).toBe(45);
  });

  it('inserts GP entries for roughly half the raiders', () => {
    seedEpgp(db);

    const total = (db.prepare('SELECT COUNT(*) as count FROM epgp_gear_points').get() as { count: number }).count;
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThanOrEqual(15);
  });

  it('inserts 5 loot history entries', () => {
    seedEpgp(db);

    const total = (db.prepare('SELECT COUNT(*) as count FROM epgp_loot_history').get() as { count: number }).count;
    expect(total).toBe(5);
  });

  it('inserts 1 upload history record', () => {
    seedEpgp(db);

    const total = (db.prepare('SELECT COUNT(*) as count FROM epgp_upload_history').get() as { count: number }).count;
    expect(total).toBe(1);
  });

  it('loot history entries have valid item_string and gear_points', () => {
    seedEpgp(db);

    const rows = db.prepare('SELECT item_string, gear_points FROM epgp_loot_history').all() as Array<{
      item_string: string;
      gear_points: number;
    }>;

    for (const row of rows) {
      expect(row.item_string).toBeTruthy();
      expect(row.gear_points).toBeGreaterThan(0);
    }
  });
});

// ─── seedLoot ────────────────────────────────────────────────────────────────

describe('seedLoot', () => {
  it('inserts 3 mock loot posts', () => {
    const result = seedLoot(db);

    expect(result.postsInserted).toBe(3);

    const rows = db.prepare('SELECT * FROM loot_posts').all();
    expect(rows).toHaveLength(3);
  });

  it('uses boss_ids 99901, 99902, 99903', () => {
    seedLoot(db);

    const rows = db.prepare('SELECT boss_id FROM loot_posts ORDER BY boss_id').all() as Array<{ boss_id: number }>;
    const ids = rows.map((r) => r.boss_id);

    expect(ids).toEqual([99901, 99902, 99903]);
  });

  it('all posts have valid boss_name, channel_id, and message_id', () => {
    seedLoot(db);

    const rows = db.prepare('SELECT * FROM loot_posts').all() as Array<{
      boss_name: string;
      channel_id: string;
      message_id: string;
    }>;

    for (const row of rows) {
      expect(row.boss_name).toBeTruthy();
      expect(row.channel_id).toBe('mock-channel-id');
      expect(row.message_id).toBeTruthy();
    }
  });

  it('third post has null boss_url', () => {
    seedLoot(db);

    const row = db.prepare('SELECT boss_url FROM loot_posts WHERE boss_id = 99903').get() as { boss_url: string | null };
    expect(row.boss_url).toBeNull();
  });

  it('is idempotent — calling twice does not duplicate posts', () => {
    seedLoot(db);
    seedLoot(db);

    const rows = db.prepare('SELECT * FROM loot_posts').all();
    expect(rows).toHaveLength(3);
  });
});

// ─── resetData ───────────────────────────────────────────────────────────────

describe('resetData', () => {
  it('clears all data and re-seeds defaults', () => {
    // Seed some data first
    seedDatabase(db);
    seedRaiders(db);
    seedApplication(db);
    seedTrial(db);
    seedLoot(db);

    // Verify data exists
    expect((db.prepare('SELECT COUNT(*) as count FROM raiders').get() as { count: number }).count).toBeGreaterThan(0);
    expect((db.prepare('SELECT COUNT(*) as count FROM loot_posts').get() as { count: number }).count).toBeGreaterThan(0);

    // Reset
    resetData(db);

    // All user data cleared
    expect((db.prepare('SELECT COUNT(*) as count FROM raiders').get() as { count: number }).count).toBe(0);
    expect((db.prepare('SELECT COUNT(*) as count FROM loot_posts').get() as { count: number }).count).toBe(0);
    expect((db.prepare('SELECT COUNT(*) as count FROM applications').get() as { count: number }).count).toBe(0);
    expect((db.prepare('SELECT COUNT(*) as count FROM trials').get() as { count: number }).count).toBe(0);
    expect((db.prepare('SELECT COUNT(*) as count FROM trial_alerts').get() as { count: number }).count).toBe(0);
  });

  it('re-seeds default guild_info_content after reset', () => {
    resetData(db);

    const count = (db.prepare('SELECT COUNT(*) as count FROM guild_info_content').get() as { count: number }).count;
    expect(count).toBeGreaterThan(0);
  });

  it('re-seeds schedule defaults after reset', () => {
    resetData(db);

    const days = (db.prepare('SELECT COUNT(*) as count FROM schedule_days').get() as { count: number }).count;
    expect(days).toBeGreaterThan(0);
  });

  it('re-seeds default_messages after reset', () => {
    resetData(db);

    const msgs = (db.prepare('SELECT COUNT(*) as count FROM default_messages').get() as { count: number }).count;
    expect(msgs).toBeGreaterThan(0);
  });

  it('re-seeds the 9 default application questions after reset', () => {
    // Pollute the DB first so we know the count didn't just carry over
    seedApplication(db);

    resetData(db);

    const count = (db.prepare('SELECT COUNT(*) as count FROM application_questions').get() as { count: number }).count;
    expect(count).toBe(9);
  });

  it('can be called on an already-empty database', () => {
    expect(() => resetData(db)).not.toThrow();
  });

  it('allows seeding data again after reset', () => {
    seedRaiders(db);
    resetData(db);
    expect(() => seedRaiders(db)).not.toThrow();

    const count = (db.prepare('SELECT COUNT(*) as count FROM raiders').get() as { count: number }).count;
    expect(count).toBe(15);
  });
});

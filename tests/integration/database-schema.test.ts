import { describe, it, expect, afterEach } from 'vitest';
import { initDatabase, closeDatabase, getDatabase, runMigrations } from '../../src/database/db.js';

describe('database schema', () => {
  afterEach(() => {
    closeDatabase();
  });

  it('should create all tables', () => {
    initDatabase(':memory:');
    const db = getDatabase();

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[];

    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain('config');
    expect(tableNames).toContain('settings');
    expect(tableNames).toContain('raiders');
    expect(tableNames).toContain('raider_identity_map');
    expect(tableNames).toContain('overlords');
    expect(tableNames).toContain('ignored_characters');
    expect(tableNames).toContain('applications');
    expect(tableNames).toContain('application_questions');
    expect(tableNames).toContain('application_answers');
    expect(tableNames).toContain('application_votes');
    expect(tableNames).toContain('trials');
    expect(tableNames).toContain('trial_alerts');
    expect(tableNames).toContain('promote_alerts');
    expect(tableNames).toContain('loot_posts');
    expect(tableNames).toContain('loot_responses');
    expect(tableNames).toContain('guild_info_content');
    expect(tableNames).toContain('schedule_days');
    expect(tableNames).toContain('schedule_config');
    expect(tableNames).toContain('guild_info_messages');
    expect(tableNames).toContain('guild_info_links');
    expect(tableNames).toContain('achievements_manual');
    expect(tableNames).toContain('default_messages');
    expect(tableNames).toContain('quip_history');
    expect(tableNames).toContain('build_info');
    expect(tableNames).toContain('achievement_ce_overrides');
    expect(tableNames).toContain('schema_version');

    // signup_messages was removed in migration v3 (#27).
    expect(tableNames).not.toContain('signup_messages');

    // The EPGP feature was removed in migration v4 — none of its tables
    // should exist on a fresh install.
    expect(tableNames).not.toContain('epgp_effort_points');
    expect(tableNames).not.toContain('epgp_gear_points');
    expect(tableNames).not.toContain('epgp_upload_history');
    expect(tableNames).not.toContain('epgp_loot_history');
    expect(tableNames).not.toContain('epgp_config');
  });

  it('should enforce foreign keys', () => {
    initDatabase(':memory:');
    const db = getDatabase();

    expect(() => {
      db.prepare(
        'INSERT INTO application_answers (application_id, question_id, answer) VALUES (999, 999, ?)',
      ).run('test');
    }).toThrow();
  });

  it('should record schema version', () => {
    initDatabase(':memory:');
    const db = getDatabase();

    const version = db
      .prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')
      .get() as { version: number };
    expect(version.version).toBe(12);
  });

  it('should be idempotent (safe to run twice)', () => {
    initDatabase(':memory:');
    // Run again - should not throw
    expect(() => initDatabase(':memory:')).not.toThrow();
  });

  it('should seed default data on first run', () => {
    initDatabase(':memory:');
    const db = getDatabase();

    const aboutUs = db.prepare("SELECT * FROM guild_info_content WHERE key = 'aboutus'").get() as
      | { content: string }
      | undefined;
    expect(aboutUs).toBeDefined();
    expect(aboutUs!.content).toContain('SeriouslyCasual');

    const schedDays = db.prepare('SELECT COUNT(*) as count FROM schedule_days').get() as {
      count: number;
    };
    expect(schedDays.count).toBe(2);

    const settings = db.prepare('SELECT COUNT(*) as count FROM settings').get() as {
      count: number;
    };
    expect(settings.count).toBe(4);

    const defaultMsgs = db.prepare('SELECT COUNT(*) as count FROM default_messages').get() as {
      count: number;
    };
    expect(defaultMsgs.count).toBe(2);

    const achievements = db.prepare('SELECT COUNT(*) as count FROM achievements_manual').get() as {
      count: number;
    };
    expect(achievements.count).toBe(4);

    const links = db.prepare('SELECT COUNT(*) as count FROM guild_info_links').get() as {
      count: number;
    };
    expect(links.count).toBe(3);
  });

  it('should not re-seed on second init', () => {
    initDatabase(':memory:');
    const db = getDatabase();

    db.prepare("UPDATE guild_info_content SET content = 'modified' WHERE key = 'aboutus'").run();

    // initDatabase on same connection shouldn't re-seed
    initDatabase(':memory:');

    const aboutUs = db.prepare("SELECT * FROM guild_info_content WHERE key = 'aboutus'").get() as {
      content: string;
    };
    expect(aboutUs.content).toBe('modified');
  });
});

describe('schema v9 — achievements cache', () => {
  afterEach(() => {
    closeDatabase();
  });

  it('creates api_cache and icon_cache tables', () => {
    initDatabase(':memory:');
    const db = getDatabase();
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('api_cache', 'icon_cache')",
      )
      .all() as { name: string }[];
    expect(tables.map((t) => t.name).sort()).toEqual(['api_cache', 'icon_cache']);
  });

  it('achievements_manual has an icon column, seeded for the four manual rows', () => {
    initDatabase(':memory:');
    const db = getDatabase();
    const cols = db.pragma('table_info(achievements_manual)') as { name: string }[];
    expect(cols.some((c) => c.name === 'icon')).toBe(true);

    const rows = db
      .prepare('SELECT raid, icon FROM achievements_manual ORDER BY expansion, sort_order')
      .all() as { raid: string; icon: string | null }[];
    expect(rows).toEqual([
      { raid: 'Siege of Orgrimmar (10 man)', icon: 'achievement_boss_garrosh' },
      { raid: 'Highmaul', icon: 'achievement_boss_highmaul_king' },
      { raid: 'Blackrock Foundry', icon: 'achievement_boss_blackhand' },
      { raid: 'Hellfire Citadel', icon: 'achievement_boss_hellfire_archimonde' },
    ]);
  });

  it('migration v9 is idempotent on a database that already ran it', () => {
    initDatabase(':memory:');
    const db = getDatabase();
    expect(() => runMigrations(db)).not.toThrow();
  });
});

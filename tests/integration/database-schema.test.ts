import { describe, it, expect, afterEach } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../src/database/db.js';

describe('database schema', () => {
  afterEach(() => {
    closeDatabase();
  });

  it('should create all tables', () => {
    initDatabase(':memory:');
    const db = getDatabase();

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
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
    expect(tableNames).toContain('epgp_effort_points');
    expect(tableNames).toContain('epgp_gear_points');
    expect(tableNames).toContain('epgp_upload_history');
    expect(tableNames).toContain('epgp_loot_history');
    expect(tableNames).toContain('epgp_config');
    expect(tableNames).toContain('guild_info_content');
    expect(tableNames).toContain('schedule_days');
    expect(tableNames).toContain('schedule_config');
    expect(tableNames).toContain('guild_info_messages');
    expect(tableNames).toContain('guild_info_links');
    expect(tableNames).toContain('achievements_manual');
    expect(tableNames).toContain('signup_messages');
    expect(tableNames).toContain('default_messages');
    expect(tableNames).toContain('schema_version');
  });

  it('should enforce foreign keys', () => {
    initDatabase(':memory:');
    const db = getDatabase();

    expect(() => {
      db.prepare('INSERT INTO application_answers (application_id, question_id, answer) VALUES (999, 999, ?)').run('test');
    }).toThrow();
  });

  it('should record schema version', () => {
    initDatabase(':memory:');
    const db = getDatabase();

    const version = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as { version: number };
    expect(version.version).toBe(1);
  });

  it('should be idempotent (safe to run twice)', () => {
    initDatabase(':memory:');
    // Run again - should not throw
    expect(() => initDatabase(':memory:')).not.toThrow();
  });

  it('should seed default data on first run', () => {
    initDatabase(':memory:');
    const db = getDatabase();

    const aboutUs = db.prepare("SELECT * FROM guild_info_content WHERE key = 'aboutus'").get() as { content: string } | undefined;
    expect(aboutUs).toBeDefined();
    expect(aboutUs!.content).toContain('SeriouslyCasual');

    const schedDays = db.prepare('SELECT COUNT(*) as count FROM schedule_days').get() as { count: number };
    expect(schedDays.count).toBe(2);

    const settings = db.prepare('SELECT COUNT(*) as count FROM settings').get() as { count: number };
    expect(settings.count).toBe(4);

    const defaultMsgs = db.prepare('SELECT COUNT(*) as count FROM default_messages').get() as { count: number };
    expect(defaultMsgs.count).toBe(2);

    const achievements = db.prepare('SELECT COUNT(*) as count FROM achievements_manual').get() as { count: number };
    expect(achievements.count).toBe(4);

    const links = db.prepare('SELECT COUNT(*) as count FROM guild_info_links').get() as { count: number };
    expect(links.count).toBe(3);
  });

  it('should not re-seed on second init', () => {
    initDatabase(':memory:');
    const db = getDatabase();

    db.prepare("UPDATE guild_info_content SET content = 'modified' WHERE key = 'aboutus'").run();

    // initDatabase on same connection shouldn't re-seed
    initDatabase(':memory:');

    const aboutUs = db.prepare("SELECT * FROM guild_info_content WHERE key = 'aboutus'").get() as { content: string };
    expect(aboutUs.content).toBe('modified');
  });
});

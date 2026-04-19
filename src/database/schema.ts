import type Database from 'better-sqlite3';

export function createTables(db: Database.Database): void {
  db.exec(`
    -- 1. schema_version
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 2. config
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- 3. settings
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL DEFAULT 0
    );

    -- 4. raider_identity_map (no FK deps)
    CREATE TABLE IF NOT EXISTS raider_identity_map (
      character_name TEXT PRIMARY KEY,
      discord_user_id TEXT NOT NULL
    );

    -- 5. overlords
    CREATE TABLE IF NOT EXISTS overlords (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL
    );

    -- 6. ignored_characters
    CREATE TABLE IF NOT EXISTS ignored_characters (
      character_name TEXT PRIMARY KEY
    );

    -- 7. raiders
    CREATE TABLE IF NOT EXISTS raiders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_name TEXT NOT NULL UNIQUE,
      realm TEXT DEFAULT 'silvermoon',
      region TEXT DEFAULT 'eu',
      rank INTEGER,
      class TEXT,
      discord_user_id TEXT,
      message_id TEXT,
      missing_since TEXT
    );

    -- 8. application_questions (must come BEFORE applications)
    CREATE TABLE IF NOT EXISTS application_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    -- 9. applications (FK to application_questions)
    CREATE TABLE IF NOT EXISTS applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_name TEXT,
      applicant_user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'in_progress',
      current_question_id INTEGER REFERENCES application_questions(id),
      channel_id TEXT,
      forum_post_id TEXT,
      thread_id TEXT,
      started_at TEXT DEFAULT (datetime('now')),
      submitted_at TEXT,
      resolved_at TEXT
    );

    -- 10. application_answers (FK to applications, application_questions)
    CREATE TABLE IF NOT EXISTS application_answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER NOT NULL REFERENCES applications(id),
      question_id INTEGER NOT NULL REFERENCES application_questions(id),
      answer TEXT NOT NULL
    );

    -- 11. application_votes (FK to applications)
    CREATE TABLE IF NOT EXISTS application_votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER NOT NULL REFERENCES applications(id),
      user_id TEXT NOT NULL,
      vote_type TEXT NOT NULL,
      UNIQUE(application_id, user_id)
    );

    -- 12. trials (FK to applications)
    CREATE TABLE IF NOT EXISTS trials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_name TEXT NOT NULL,
      role TEXT NOT NULL,
      start_date TEXT NOT NULL,
      thread_id TEXT,
      logs_message_id TEXT,
      application_id INTEGER REFERENCES applications(id),
      status TEXT DEFAULT 'active'
    );

    -- 13. trial_alerts (FK to trials)
    CREATE TABLE IF NOT EXISTS trial_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trial_id INTEGER NOT NULL REFERENCES trials(id),
      alert_name TEXT NOT NULL,
      alert_date TEXT NOT NULL,
      alerted INTEGER NOT NULL DEFAULT 0
    );

    -- 14. promote_alerts (FK to trials)
    CREATE TABLE IF NOT EXISTS promote_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trial_id INTEGER NOT NULL REFERENCES trials(id),
      thread_id TEXT NOT NULL,
      promote_date TEXT NOT NULL
    );

    -- 15. loot_posts
    CREATE TABLE IF NOT EXISTS loot_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      boss_id INTEGER NOT NULL UNIQUE,
      boss_name TEXT NOT NULL,
      boss_url TEXT,
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL
    );

    -- 16. loot_responses (FK to loot_posts)
    CREATE TABLE IF NOT EXISTS loot_responses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      loot_post_id INTEGER NOT NULL REFERENCES loot_posts(id),
      user_id TEXT NOT NULL,
      response_type TEXT NOT NULL,
      UNIQUE(loot_post_id, user_id)
    );

    -- 17. epgp_effort_points (FK to raiders)
    CREATE TABLE IF NOT EXISTS epgp_effort_points (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      raider_id INTEGER NOT NULL REFERENCES raiders(id),
      points REAL NOT NULL,
      timestamp TEXT DEFAULT (datetime('now'))
    );

    -- 18. epgp_gear_points (FK to raiders)
    CREATE TABLE IF NOT EXISTS epgp_gear_points (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      raider_id INTEGER NOT NULL REFERENCES raiders(id),
      points REAL NOT NULL,
      timestamp TEXT DEFAULT (datetime('now'))
    );

    -- 19. epgp_upload_history
    CREATE TABLE IF NOT EXISTS epgp_upload_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT DEFAULT (datetime('now')),
      decay_percent REAL NOT NULL DEFAULT 0,
      uploaded_content TEXT
    );

    -- 20. epgp_loot_history (FK to raiders)
    CREATE TABLE IF NOT EXISTS epgp_loot_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      raider_id INTEGER NOT NULL REFERENCES raiders(id),
      item_id TEXT,
      item_string TEXT NOT NULL,
      gear_points REAL NOT NULL,
      looted_at TEXT NOT NULL
    );

    -- 21. epgp_config
    CREATE TABLE IF NOT EXISTS epgp_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- 22. guild_info_content
    CREATE TABLE IF NOT EXISTS guild_info_content (
      key TEXT PRIMARY KEY,
      title TEXT,
      content TEXT NOT NULL
    );

    -- 23. schedule_days
    CREATE TABLE IF NOT EXISTS schedule_days (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day TEXT NOT NULL,
      time TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    -- 24. schedule_config
    CREATE TABLE IF NOT EXISTS schedule_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- 25. guild_info_messages
    CREATE TABLE IF NOT EXISTS guild_info_messages (
      key TEXT PRIMARY KEY,
      message_id TEXT NOT NULL
    );

    -- 26. guild_info_links
    CREATE TABLE IF NOT EXISTS guild_info_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      url TEXT NOT NULL,
      emoji_id TEXT
    );

    -- 27. achievements_manual
    CREATE TABLE IF NOT EXISTS achievements_manual (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      raid TEXT NOT NULL,
      progress TEXT NOT NULL,
      result TEXT NOT NULL,
      expansion INTEGER NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    -- 28. default_messages
    CREATE TABLE IF NOT EXISTS default_messages (
      key TEXT PRIMARY KEY,
      message TEXT NOT NULL
    );
  `);
}

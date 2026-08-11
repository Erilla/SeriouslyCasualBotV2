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
      missing_since TEXT,
      inactive_since TEXT
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
      resolved_at TEXT,
      -- When overlords were told the applicant left the Discord. NULL means not
      -- yet told, so the startup sweep can find departures missed while the bot
      -- was restarting without ever notifying twice.
      departed_notified_at TEXT
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
      status TEXT DEFAULT 'active',
      discord_user_id TEXT,
      departed_notified_at TEXT
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

    -- 17. guild_info_content
    CREATE TABLE IF NOT EXISTS guild_info_content (
      key TEXT PRIMARY KEY,
      title TEXT,
      content TEXT NOT NULL
    );

    -- 18. schedule_days
    CREATE TABLE IF NOT EXISTS schedule_days (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day TEXT NOT NULL,
      time TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    -- 19. schedule_config
    CREATE TABLE IF NOT EXISTS schedule_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- 20. guild_info_messages
    CREATE TABLE IF NOT EXISTS guild_info_messages (
      key TEXT PRIMARY KEY,
      message_id TEXT NOT NULL
    );

    -- 21. guild_info_links
    CREATE TABLE IF NOT EXISTS guild_info_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      url TEXT NOT NULL,
      emoji_id TEXT
    );

    -- 22. achievements_manual
    CREATE TABLE IF NOT EXISTS achievements_manual (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      raid TEXT NOT NULL,
      progress TEXT NOT NULL,
      result TEXT NOT NULL,
      expansion INTEGER NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      icon TEXT
    );

    -- 23. default_messages
    CREATE TABLE IF NOT EXISTS default_messages (
      key TEXT PRIMARY KEY,
      message TEXT NOT NULL
    );

    -- 24. quip_history
    CREATE TABLE IF NOT EXISTS quip_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quip TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 25. build_info (build-number cache, keyed by deployed commit SHA)
    CREATE TABLE IF NOT EXISTS build_info (
      sha   TEXT PRIMARY KEY,
      build INTEGER NOT NULL
    );

    -- 26. api_cache (Raider.IO response cache for the achievements image)
    CREATE TABLE IF NOT EXISTS api_cache (
      key TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    );

    -- 27. icon_cache (WoW icon images fetched from zamimg)
    CREATE TABLE IF NOT EXISTS icon_cache (
      name TEXT PRIMARY KEY,
      image BLOB NOT NULL,
      fetched_at TEXT NOT NULL
    );

    -- 28. achievement_ce_overrides (officer-managed CE cutoffs, not cache data)
    CREATE TABLE IF NOT EXISTS achievement_ce_overrides (
      raid_slug TEXT PRIMARY KEY,
      cutoff_at TEXT NOT NULL
    );

    -- 29. applicant intel: resumable per-applicant sweep (jobs, work queue,
    -- scanned characters, findings). Normalised rather than a JSON blob
    -- because the scanned set reaches thousands of rows written one at a time.
    CREATE TABLE IF NOT EXISTS applicant_intel_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER,
      target_channel_id TEXT,
      character_name TEXT NOT NULL,
      character_realm TEXT NOT NULL,
      character_region TEXT NOT NULL,
      phase TEXT NOT NULL DEFAULT 'logs',
      status TEXT NOT NULL DEFAULT 'pending',
      resume_after TEXT,
      paused_service TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      logs_message_id TEXT,
      alts_message_id TEXT,
      guilds_message_id TEXT,
      applicant_discord TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS applicant_intel_queue (
      job_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      payload TEXT,
      done INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (job_id, kind, key)
    );

    CREATE TABLE IF NOT EXISTS applicant_intel_scanned (
      job_id INTEGER NOT NULL,
      character_key TEXT NOT NULL,
      PRIMARY KEY (job_id, character_key)
    );

    CREATE TABLE IF NOT EXISTS applicant_intel_findings (
      job_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      realm TEXT NOT NULL,
      class TEXT,
      guild_name TEXT,
      guild_realm TEXT,
      source TEXT NOT NULL,
      confidence REAL,
      discord_status TEXT,
      discord_profile TEXT,
      PRIMARY KEY (job_id, name, realm)
    );
  `);
}

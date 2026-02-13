/**
 * SQL statements for creating all database tables.
 * Each table is created with IF NOT EXISTS for idempotency.
 */

export const TABLE_SCHEMAS: string[] = [
    // Channel/role configuration set via /setup
    `CREATE TABLE IF NOT EXISTS channel_config (
        key TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        guild_id TEXT NOT NULL
    )`,

    // Feature toggle settings
    `CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )`,

    // Guild roster synced from Raider.io
    `CREATE TABLE IF NOT EXISTS raiders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        character_name TEXT NOT NULL,
        discord_user_id TEXT,
        realm TEXT,
        region TEXT NOT NULL DEFAULT 'eu'
    )`,

    // Guild leadership members
    `CREATE TABLE IF NOT EXISTS overlords (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        discord_user_id TEXT NOT NULL UNIQUE
    )`,

    // Characters excluded from roster checks
    `CREATE TABLE IF NOT EXISTS ignored_characters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        character_name TEXT NOT NULL UNIQUE
    )`,

    // Active trial members
    `CREATE TABLE IF NOT EXISTS trials (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL UNIQUE,
        character_name TEXT NOT NULL,
        role TEXT NOT NULL,
        start_date TEXT NOT NULL,
        trial_review_message_id TEXT,
        trial_logs_message_id TEXT,
        extended INTEGER NOT NULL DEFAULT 0
    )`,

    // Scheduled trial review alerts
    `CREATE TABLE IF NOT EXISTS trial_alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
        alert_date TEXT NOT NULL,
        sent INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (thread_id) REFERENCES trials(thread_id) ON DELETE CASCADE
    )`,

    // Trials pending promotion
    `CREATE TABLE IF NOT EXISTS promote_alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL UNIQUE,
        FOREIGN KEY (thread_id) REFERENCES trials(thread_id) ON DELETE CASCADE
    )`,

    // Guild applications
    `CREATE TABLE IF NOT EXISTS applications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        channel_id TEXT,
        forum_post_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        submitted_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,

    // Configurable application questions (custom mode)
    `CREATE TABLE IF NOT EXISTS application_questions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        question_text TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1
    )`,

    // In-progress DM application sessions
    `CREATE TABLE IF NOT EXISTS application_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'in_progress',
        current_question INTEGER NOT NULL DEFAULT 0,
        answers TEXT NOT NULL DEFAULT '[]',
        channel_id TEXT,
        forum_post_id TEXT
    )`,

    // Voting messages for applications
    `CREATE TABLE IF NOT EXISTS application_votes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        forum_post_id TEXT NOT NULL UNIQUE
    )`,

    // Individual vote entries
    `CREATE TABLE IF NOT EXISTS vote_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        forum_post_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        vote_type TEXT NOT NULL,
        UNIQUE(forum_post_id, user_id),
        FOREIGN KEY (forum_post_id) REFERENCES application_votes(forum_post_id) ON DELETE CASCADE
    )`,

    // Boss loot posts
    `CREATE TABLE IF NOT EXISTS loot_posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        boss_id INTEGER NOT NULL,
        boss_name TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        message_id TEXT NOT NULL UNIQUE
    )`,

    // Player responses to loot posts
    `CREATE TABLE IF NOT EXISTS loot_responses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        boss_id INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        response_type TEXT NOT NULL,
        character_name TEXT,
        UNIQUE(boss_id, user_id),
        FOREIGN KEY (boss_id) REFERENCES loot_posts(boss_id) ON DELETE CASCADE
    )`,

    // Key-value store for guild info embed message IDs
    `CREATE TABLE IF NOT EXISTS guild_info (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )`,

    // Key-value store for EPGP priority post
    `CREATE TABLE IF NOT EXISTS priority_loot_post (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )`,

    // Application outcome analytics
    `CREATE TABLE IF NOT EXISTS application_analytics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        submitted_at TEXT NOT NULL,
        decided_at TEXT,
        outcome TEXT,
        votes_for INTEGER NOT NULL DEFAULT 0,
        votes_neutral INTEGER NOT NULL DEFAULT 0,
        votes_against INTEGER NOT NULL DEFAULT 0
    )`,

    // Raid attendance tracking
    `CREATE TABLE IF NOT EXISTS raid_attendance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        raid_date TEXT NOT NULL,
        raid_id TEXT NOT NULL,
        character_name TEXT NOT NULL,
        user_id TEXT,
        signup_status TEXT NOT NULL
    )`,

    // Trial outcome analytics
    `CREATE TABLE IF NOT EXISTS trial_analytics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        character_name TEXT NOT NULL,
        start_date TEXT NOT NULL,
        end_date TEXT,
        outcome TEXT,
        extensions INTEGER NOT NULL DEFAULT 0
    )`,
];

/** Default settings inserted on first run */
export const DEFAULT_SETTINGS: Array<{ key: string; value: string }> = [
    { key: 'alert_signups', value: 'true' },
    { key: 'alert_mythicplus', value: 'true' },
    { key: 'alert_trials', value: 'true' },
    { key: 'alert_applications', value: 'true' },
    { key: 'use_custom_applications', value: 'false' },
];

/** Default application questions inserted on first run */
export const DEFAULT_APPLICATION_QUESTIONS: string[] = [
    'What class and (if multi-role) spec are you applying as?',
    'Please link your Raider.IO profile of the character you wish to apply with',
    'Tell us about yourself - age, location, and any other aspects you\'re willing to share',
    'How did you find us and what made you want to apply to SeriouslyCasual? (Include any known members)',
    'What is your current and past experience in raiding at the highest level? (MYTHIC progression while current only, include logs)',
    'We aim to achieve Cutting Edge every tier. If you haven\'t done this, showcase your ability (M+ logs, PvP achievements, heroic logs, etc.)',
    'Could you commit to both a Wednesday and Sunday raid each week? Is there anything that might interfere?',
    'Do you have an offspec or other classes you\'d play and raid as? If so, provide logs (Mythic preferred)',
    'Would you like to include any further information to support your application?',
];

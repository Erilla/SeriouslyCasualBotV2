# Database

## Technology

SQLite via [better-sqlite3](https://github.com/WiseLibs/better-sqlite3). WAL journal mode and foreign key enforcement are enabled on every connection.

```ts
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
```

The database file defaults to `db.sqlite` in the working directory. Override with the `DB_PATH` env var.

## Tables

| Table | Description |
|---|---|
| `schema_version` | Tracks applied migration versions |
| `config` | Key-value channel/role configuration set by `/setup` |
| `settings` | Key-value feature toggles (0/1) managed by `/settings` |
| `raiders` | Guild roster synced from WoW Audit |
| `raider_identity_map` | Maps character names to Discord user IDs |
| `overlords` | Officers/admins with elevated bot permissions |
| `ignored_characters` | Characters excluded from roster sync |
| `application_questions` | Ordered questions for the custom application flow |
| `applications` | Application records (in_progress, submitted, resolved) |
| `application_answers` | Per-question answers for each application |
| `application_votes` | Officer votes on pending applications |
| `trials` | Active trial member records |
| `trial_alerts` | Scheduled alert events per trial |
| `promote_alerts` | Scheduled promotion reminders per trial |
| `loot_posts` | Boss loot posts in loot channel |
| `loot_responses` | Player loot responses per post |
| `epgp_effort_points` | EPGP effort point transactions per raider |
| `epgp_gear_points` | EPGP gear point transactions per raider |
| `epgp_loot_history` | EPGP loot award history per raider |
| `epgp_upload_history` | EPGP CSV upload history |
| `epgp_config` | EPGP configuration key-value store |
| `guild_info_content` | Editable sections for the guild info embed |
| `guild_info_messages` | Pinned message IDs for guild info embeds |
| `guild_info_links` | Links displayed in the guild info embed |
| `schedule_days` | Raid schedule entries |
| `schedule_config` | Schedule display configuration |
| `achievements_manual` | Manually entered raid achievement records |
| `signup_messages` | Rotating messages sent with raid signups |
| `default_messages` | Default text templates for various bot messages |

## Migration System

Migrations are versioned files in `src/database/migrations/`. `initDatabase()` calls `runMigrations()` which:

1. Creates `schema_version` if it doesn't exist
2. Reads the highest applied version number
3. Applies any pending migrations in order, recording each version in `schema_version`

New migrations go in `migrations/00N_description.ts` and export `version: number` and `up(db): void`.

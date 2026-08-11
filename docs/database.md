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
| `raiders` | Guild roster synced from Raider.IO; tracks `missing_since` / `inactive_since` for the missing→inactive lifecycle |
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
| `guild_info_content` | Editable sections for the guild info embed |
| `guild_info_messages` | Pinned message IDs for guild info embeds |
| `guild_info_links` | Links displayed in the guild info embed |
| `schedule_days` | Raid schedule entries |
| `schedule_config` | Schedule display configuration |
| `achievements_manual` | Manually entered raid achievement records |
| `default_messages` | Default text templates for various bot messages |
| `quip_history` | Recent LLM-generated signup quips, fed back into the prompt as anti-repetition context (trimmed to newest 50) |
| `build_info` | Build-number cache, keyed by deployed commit SHA |

## Migration System

`createTables()` (in `schema.ts`) is the idempotent baseline — every table is `CREATE TABLE IF NOT EXISTS`, so a fresh database comes up fully formed. Migrations exist only to transform databases that predate a schema change.

Migrations are inline, forward-only version blocks in `runMigrations()` (in `db.ts`), **not** separate files. `initDatabase()` runs them after `createTables()`:

1. Creates `schema_version` if it doesn't exist
2. Reads the highest applied version number (`0` on a fresh DB)
3. Runs each `if (currentVersion < N)` block in order, recording version `N` in `schema_version` inside the same transaction

The current head is **version 13**. Applied migrations:

| Version | Change |
|---|---|
| 1 | Baseline marker |
| 2 | Rename `epgp_channel_id` config key → `epgp_rankings_channel_id` (superseded by v4) |
| 3 | Drop the `signup_messages` table (quips now generated on demand) |
| 4 | Drop the EPGP feature (five `epgp_*` tables + orphaned config keys) |
| 5 | Add `raiders.inactive_since` and retire long-missing raiders to inactive |
| 6 | Drop the orphaned `officer_role_id` config key (officer role now env-only) |
| 7 | Add the `quip_history` table (anti-repetition memory for signup quips) |
| 8 | Add the `build_info` table (build-number cache, keyed by deployed commit SHA) |
| 9 | Add `achievements_manual.icon` and backfill icons for the known manual rows |
| 10 | Add the `achievement_ce_overrides` table (officer-managed CE cutoffs) |
| 11 | Add the four `applicant_intel_*` tables (resumable applicant-intel sweep) |
| 12 | Add `applications.departed_notified_at` (applicant-departure notified once, ever) |
| 13 | Add `trials.discord_user_id` (the Discord account linked to this trial; NULL = unknown, never notified) and `trials.departed_notified_at` (trial-departure notified once, ever); back-fills `discord_user_id` from the linked application first, then from `raiders` by character name |

When adding a migration, also bump the hardcoded latest-version assertion in
`tests/integration/database-schema.test.ts` — CI runs the integration suite
and fails otherwise.

Migrations must stay idempotent against fresh DBs, where `createTables()` has already produced the final schema — guard `ALTER`/`DROP` accordingly (e.g. v5 checks `table_info` before adding the column, drops use `IF EXISTS`).

To add a migration, append a new `if (currentVersion < 14) { ... }` block that ends by inserting the version row.

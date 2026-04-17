# SeriouslyCasualBot V2 - Design Spec

A Discord bot for the World of Warcraft guild **Seriously Casual** on EU-Silvermoon. Manages guild applications, trial reviews, raid roster syncing, loot priority signups, EPGP rankings, and guild information displays.

This is a ground-up rewrite of V1 (CommonJS, Keyv, no types) with the goals of **reliability**, **simplicity**, and **performance**.

---

## Tech Stack

| Technology | Purpose |
|-----------|---------|
| TypeScript 5.x | Strict mode, ESM, Node16 module resolution |
| Discord.js v14 | Bot framework (slash commands, buttons, modals, select menus, forums) |
| better-sqlite3 | Synchronous SQLite with WAL mode, foreign keys |
| node-cron | Cron scheduling (for time-of-day tasks only) |
| axios | HTTP client (all external APIs) |
| dotenv | Environment variable loading |
| tsx | Dev runner (watch mode) |

**Runtime:** Node.js 20 LTS, ESM modules, `.js` extensions in imports.

---

## Project Structure

```
src/
  index.ts              # Entry: create client, load commands/events, login
  config.ts             # Single config module, validates env vars at startup
  deploy-commands.ts    # Register slash commands to guild
  database/
    db.ts               # getDatabase() singleton, initDatabase()
    schema.ts           # CREATE TABLE statements
    seed.ts             # Default seed data (guild info content, messages, etc.)
  types/
    index.ts            # All interfaces: Command, BotEvent, BotClient, DB row types
  commands/             # One file per command group
  events/               # interactionCreate.ts, ready.ts, threadUpdate.ts, messageCreate.ts
  services/             # External API wrappers
    raiderio.ts         # Guild roster, raid rankings, static data, M+ runs
    wowaudit.ts         # Raid signups, historical data
    warcraftlogs.ts     # OAuth2 + GraphQL for raid attendance
  functions/            # Business logic by domain
    applications/
    trial-review/
    raids/
    loot/
    epgp/
    guild-info/
    settings/
  scheduler/
    scheduler.ts        # Wrapped cron/interval with error handling + overlap prevention
  utils.ts              # Shared helpers (asSendable, channel narrowing)
```

No `data/` directory. All content lives in the database, seeded on first run from `seed.ts`.

---

## Environment Variables

```
DISCORD_TOKEN       # Bot token
CLIENT_ID           # Discord application client ID
GUILD_ID            # Target guild ID
WOWAUDIT_API_SECRET # WoW Audit API authorization token
WARCRAFTLOGS_CLIENT_ID     # WarcraftLogs OAuth2 client ID
WARCRAFTLOGS_CLIENT_SECRET # WarcraftLogs OAuth2 client secret
LOG_LEVEL           # INFO, DEBUG, WARN, ERROR
NODE_ENV            # development, production
```

No Redis. No external database. No EPGP backend API.

---

## Database Schema

All persistent state in SQLite. Real SQL tables with foreign keys, indexes, and proper types. Replaces V1's 14 Keyv key-value namespaces.

### config

Channel IDs, role IDs, and bot configuration. Set via `/setup` or auto-populated when the bot creates channels.

```sql
CREATE TABLE config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

### settings

Feature toggles (signup alerts, etc.).

```sql
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0  -- 0 = false, 1 = true
);
```

### raiders

Guild roster. Synced from Raider.io.

```sql
CREATE TABLE raiders (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  character_name TEXT NOT NULL UNIQUE,
  realm          TEXT NOT NULL DEFAULT 'silvermoon',
  rank           INTEGER,
  discord_user_id TEXT,          -- NULL if not yet linked
  message_id     TEXT            -- bot-setup message ID for this raider (prevents duplication)
);
```

### overlords

Officers who get added to threads and mentioned in recruitment.

```sql
CREATE TABLE overlords (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  name    TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL          -- Discord user ID
);
```

### ignored_characters

Characters excluded from roster sync.

```sql
CREATE TABLE ignored_characters (
  character_name TEXT PRIMARY KEY
);
```

### applications

Active and historical applications.

```sql
CREATE TABLE applications (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  character_name  TEXT NOT NULL,
  applicant_user_id TEXT NOT NULL,   -- Discord user ID
  status          TEXT NOT NULL DEFAULT 'active',  -- active, accepted, rejected
  channel_id      TEXT,              -- app-{name} text channel ID
  forum_post_id   TEXT,              -- application-log forum post ID
  thread_id       TEXT,              -- forum thread ID
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### application_questions

Configurable questionnaire stored in DB.

```sql
CREATE TABLE application_questions (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  question  TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);
```

### application_answers

Responses to the questionnaire per application.

```sql
CREATE TABLE application_answers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id  INTEGER NOT NULL REFERENCES applications(id),
  question_id     INTEGER NOT NULL REFERENCES application_questions(id),
  answer          TEXT NOT NULL
);
```

### application_votes

Per-user votes on applications.

```sql
CREATE TABLE application_votes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id  INTEGER NOT NULL REFERENCES applications(id),
  user_id         TEXT NOT NULL,
  vote_type       TEXT NOT NULL,  -- for, neutral, against, kekw
  UNIQUE(application_id, user_id)
);
```

### trials

Active trial members with review scheduling.

```sql
CREATE TABLE trials (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  character_name  TEXT NOT NULL,
  role            TEXT NOT NULL,
  start_date      TEXT NOT NULL,
  thread_id       TEXT,           -- trial review thread ID
  logs_message_id TEXT,           -- pinned logs message in thread
  application_id  INTEGER REFERENCES applications(id),
  status          TEXT NOT NULL DEFAULT 'active'  -- active, promoted, closed
);
```

### trial_alerts

Per-trial review alert tracking. Pre-calculated on trial creation.

```sql
CREATE TABLE trial_alerts (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  trial_id  INTEGER NOT NULL REFERENCES trials(id),
  alert_name TEXT NOT NULL,       -- 2_week, 4_week, 6_week
  alert_date TEXT NOT NULL,
  alerted   INTEGER NOT NULL DEFAULT 0
);
```

### promote_alerts

Scheduled promotion reminders.

```sql
CREATE TABLE promote_alerts (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  trial_id  INTEGER NOT NULL REFERENCES trials(id),
  thread_id TEXT NOT NULL,
  promote_date TEXT NOT NULL
);
```

### loot_posts

Per-boss loot posts.

```sql
CREATE TABLE loot_posts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  boss_id    INTEGER NOT NULL UNIQUE,
  boss_name  TEXT NOT NULL,
  boss_url   TEXT,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL
);
```

### loot_responses

Per-user per-boss loot priority.

```sql
CREATE TABLE loot_responses (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  loot_post_id  INTEGER NOT NULL REFERENCES loot_posts(id),
  user_id       TEXT NOT NULL,
  response_type TEXT NOT NULL,  -- major, minor, wantIn, wantOut
  UNIQUE(loot_post_id, user_id)
);
```

### epgp_points

EPGP data uploaded by officers from the WoW addon.

```sql
CREATE TABLE epgp_points (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  character_name    TEXT NOT NULL UNIQUE,
  effort_points     REAL NOT NULL DEFAULT 0,
  gear_points       REAL NOT NULL DEFAULT 0,
  priority          REAL NOT NULL DEFAULT 0,
  ep_difference     REAL NOT NULL DEFAULT 0,
  gp_difference     REAL NOT NULL DEFAULT 0,
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### epgp_config

Message IDs for the 3-message EPGP display.

```sql
CREATE TABLE epgp_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

### guild_info_content

Seeded content for guild info embeds. Editable via slash commands.

```sql
CREATE TABLE guild_info_content (
  key     TEXT PRIMARY KEY,
  title   TEXT,
  content TEXT NOT NULL
);
```

Keys: `aboutus`, `achievements_title`, `recruitment_*` (one per section).

### schedule_days

Raid schedule with per-day times.

```sql
CREATE TABLE schedule_days (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  day       TEXT NOT NULL,
  time      TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);
```

### schedule_config

Schedule metadata (title, timezone).

```sql
CREATE TABLE schedule_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

Keys: `title`, `timezone`.

### guild_info_messages

Tracks posted message IDs for edit-in-place updates.

```sql
CREATE TABLE guild_info_messages (
  key        TEXT PRIMARY KEY,
  message_id TEXT NOT NULL
);
```

### guild_info_links

Link buttons for the About Us embed.

```sql
CREATE TABLE guild_info_links (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  label    TEXT NOT NULL,
  url      TEXT NOT NULL,
  emoji_id TEXT
);
```

### achievements_manual

Manual achievement data for older expansions not on Raider.io.

```sql
CREATE TABLE achievements_manual (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  raid      TEXT NOT NULL,
  progress  TEXT NOT NULL,
  result    TEXT NOT NULL,
  expansion INTEGER NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);
```

### signup_messages

Random messages for signup alerts.

```sql
CREATE TABLE signup_messages (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  message TEXT NOT NULL
);
```

### default_messages

Default messages for application accept/reject DMs.

```sql
CREATE TABLE default_messages (
  key     TEXT PRIMARY KEY,
  message TEXT NOT NULL
);
```

Keys: `application_accept`, `application_reject`.

---

## Domain: Applications

Custom application system. No legacy/external bot mode.

### Trigger

User clicks "Apply Now" button (posted via `/applications post_apply_button`) or runs `/apply`.

### DM Questionnaire Flow

1. Bot DMs the user with questions one at a time from `application_questions` table (ordered by `sort_order`)
2. User responds in DM, bot stores answer and sends next question
3. After all questions: bot shows a summary with Confirm/Cancel buttons
4. **Cancel:** Bot says goodbye, cleans up DM state
5. **Confirm:** Proceeds to channel + forum post creation

### On Confirm

1. **Create text channel** `app-{charactername}` in the applications category
   - Permissions: applicant can read/write, overlords can read/write, everyone else denied
   - If applications category doesn't exist, create it
   - Post the full Q&A as the first message
2. **Create forum post** in application-log forum
   - If application-log forum doesn't exist, create it
   - Title: character name
   - Tag: Active (auto-create tag if missing)
   - First message: full Q&A + metadata (date, applicant mention)
   - Second message: voting embed with for/neutral/against/kekw buttons (usable by anyone who can see the post)
   - Third message: Accept/Reject buttons (officer-only on click, visible to all)
3. **Store** application record in DB with channel_id, forum_post_id, thread_id
4. **Notify** overlords

### Voting

- Buttons: for, neutral, against, kekw
- Any user who can see the forum post can vote
- One vote per user (clicking a different button changes your vote)
- Voting embed shows progress bar and voter names per category
- Stored in `application_votes` table with UNIQUE(application_id, user_id) constraint

### Accept Flow

1. Officer clicks Accept button on forum post
2. Bot checks officer role - rejects with ephemeral if not authorized
3. Modal opens with:
   - **Character name** (pre-filled from application)
   - **Role** (text input)
   - **Start date** (YYYY-MM-DD)
   - **Message to applicant** (paragraph, pre-filled with `application_accept` default message from `default_messages` table)
4. On submit:
   - DM applicant with the (possibly edited) accept message
   - Remove Active tag, add Accepted tag on forum post
   - Archive the `app-{name}` text channel
   - Update application status to `accepted` in DB
   - Create trial review thread (cross-domain bridge)

### Reject Flow

1. Officer clicks Reject button on forum post
2. Bot checks officer role - rejects with ephemeral if not authorized
3. Modal opens with:
   - **Message to applicant** (paragraph, pre-filled with `application_reject` default message from `default_messages` table)
4. On submit:
   - DM applicant with the (possibly edited) reject message
   - Remove Active tag, add Rejected tag on forum post
   - Archive the `app-{name}` text channel
   - Update application status to `rejected` in DB

### Slash Commands

| Command | Subcommand | Description |
|---------|-----------|-------------|
| `/apply` | - | User-facing, triggers DM questionnaire |
| `/applications` | `post_apply_button` | Posts "Apply Now" button embed in current channel |
| `/applications` | `add_question` | Add a question to the questionnaire |
| `/applications` | `remove_question` | Remove a question by ID |
| `/applications` | `list_questions` | View current questions |
| `/applications` | `view_pending` | List active applications |
| `/applications` | `set_accept_message` | Edit the default accept DM message |
| `/applications` | `set_reject_message` | Edit the default reject DM message |

### Button Custom IDs

| Custom ID | Handler |
|-----------|---------|
| `application:apply` | Start DM questionnaire (same as `/apply`) |
| `application:confirm` | Confirm application submission in DM |
| `application:cancel` | Cancel application in DM |
| `application_vote:for` | Cast a for-vote |
| `application_vote:neutral` | Cast a neutral-vote |
| `application_vote:against` | Cast an against-vote |
| `application_vote:kekw` | Cast a kekw-vote |
| `application:accept` | Officer accept (opens modal) |
| `application:reject` | Officer reject (opens modal) |

### Events

- `messageCreate`: handles DM responses during questionnaire (match by user state in memory)

---

## Domain: Trial Review

Probationary member tracking from acceptance through review to promotion/closure.

### Trial Creation

Triggered by accepting an application (cross-domain) or manually via `/trials create_thread`.

1. Create thread in trial-reviews forum (auto-create forum if missing)
2. Post review message with trial info (character, role, start date, review dates)
3. Post WarcraftLogs attendance links (fetched via OAuth2 + GraphQL)
4. Add 4 action buttons: Update Info, Extend, Mark for Promotion, Close Trial
5. Add overlords to thread
6. Calculate review alert dates (2-week, 4-week, 6-week) and schedule via `setTimeout`
7. Store trial + alerts in DB

### Alert System (Event-Driven)

- On trial creation: calculate exact alert timestamps, store in `trial_alerts` table
- Use `setTimeout` for each pending alert (fire at the exact time)
- On bot restart: query `trial_alerts` where `alerted = 0` and `alert_date` is in the future, re-schedule `setTimeout` for each
- Alerts that were missed during downtime fire immediately on restart
- When alert fires: send notification to the trial thread, mark `alerted = 1`

### Promotion Scheduling (Event-Driven)

- When officer clicks "Mark for Promotion": store promote date in `promote_alerts`, schedule `setTimeout`
- On fire: send promotion reminder to thread mentioning admin role
- On bot restart: re-schedule any pending promote alerts

### Thread Maintenance (Event-Driven)

- On thread creation: set auto-archive to maximum duration
- Listen to `threadUpdate` event: if a trial thread gets auto-archived, unarchive it and alert

### WarcraftLogs Integration

- OAuth2 client credentials flow with token caching
- GraphQL query for guild attendance data
- Filters by character name and presence
- Pinned message in thread with log links (reverse chronological)
- Refreshed every 60 minutes (polling - WarcraftLogs has no webhooks)

### Slash Commands

| Command | Subcommand | Description |
|---------|-----------|-------------|
| `/trials` | `create_thread` | Opens modal to manually create a trial |
| `/trials` | `get_current_trials` | List all active trials |
| `/trials` | `remove_trial` | Remove a trial by thread ID |
| `/trials` | `change_trial_info` | Edit trial character name, role, or start date |
| `/trials` | `update_trial_logs` | Refresh all WarcraftLogs messages |
| `/trials` | `update_trial_review_messages` | Refresh all trial review messages |

### Button Custom IDs

| Custom ID | Handler |
|-----------|---------|
| `trial:update_info` | Opens modal to edit trial info |
| `trial:extend` | Extend trial by one week |
| `trial:mark_promote` | Mark trial for promotion |
| `trial:close` | Close trial and archive thread |

---

## Domain: Raids

Roster management, signup alerts, and weekly reports.

### Roster Sync (Polling - every 10m)

1. Fetch live roster from `raiderioService.getGuildRoster()`
2. Compare against `raiders` table
3. Remove raiders no longer in roster (unless in `ignored_characters`)
4. Add new raiders with `discord_user_id = NULL`
5. For new raiders without a Discord user: post alert to bot-setup channel with user select menu + ignore button
6. Track message ID per raider in `raiders.message_id` to prevent duplication (V1 bug fix)
7. Post sync summary to bot-setup channel

### Missing User Alerts

Each unlinked raider gets one message in bot-setup with:
- User select menu (officer picks the Discord user)
- "Ignore character" button

Message ID stored in `raiders.message_id`. On next sync: if raider now has a user, delete the message. Only create a new message if no `message_id` exists.

### Signup Alerts (Cron - 7PM Mon/Tue/Fri/Sat)

1. Check the relevant setting (e.g., `alertSignup_Wednesday`) - skip if disabled
2. Fetch upcoming Mythic raids from WoW Audit
3. Find unsigned raiders (status = Unknown)
4. Resolve Discord user IDs from `raiders` table
5. Pick random message from `signup_messages` table
6. Post alert to raiders lounge channel with mentions
7. 48-hour reminders include Discord relative timestamps

### Weekly Reports (Cron - Noon Wednesday)

1. Fetch historical data from WoW Audit (previous period)
2. For each raider: fetch M+ runs from Raider.io
3. Generate two text file attachments:
   - Highest M+ runs per raider
   - Great Vault status per raider
4. Post to weekly-check channel

### Slash Commands

| Command | Subcommand | Description |
|---------|-----------|-------------|
| `/raiders` | `get_raiders` | List current raiders |
| `/raiders` | `get_ignored_characters` | List ignored characters |
| `/raiders` | `ignore_character` | Add to ignore list |
| `/raiders` | `remove_ignore_character` | Remove from ignore list |
| `/raiders` | `sync_raiders` | Manual roster sync |
| `/raiders` | `check_missing_users` | Post alerts for unlinked raiders |
| `/raiders` | `update_raider_user` | Link a raider to a Discord user |
| `/raiders` | `previous_highest_mythicplus` | Weekly M+ report (manual trigger) |
| `/raiders` | `previous_great_vault` | Weekly vault report (manual trigger) |
| `/raiders` | `add_overlord` | Add an officer |
| `/raiders` | `get_overlords` | List officers |
| `/raiders` | `remove_overlord` | Remove an officer |

### Button/Select Custom IDs

| Custom ID | Handler |
|-----------|---------|
| `raider:ignore:{characterName}` | Ignore a character |
| `raider:select_user:{characterName}` | User select menu for linking |

---

## Domain: Loot

Boss loot priority signups for the current raid tier.

### Auto-Discovery

`/loot create_posts` triggers discovery:
1. Walk Raider.io expansions starting at 9, incrementing until 400 response
2. Sort raids by end date
3. First raid where `ends.eu > now` is the current tier
4. Create one embed+buttons per boss encounter in the loot channel

### Loot Post

Per-boss embed with 4 inline fields (Major, Minor, Want In, Do Not Need) showing character names. Four buttons below.

### Response Flow

1. Raider clicks a button
2. Validate raider exists in `raiders` table (early return with ephemeral error if not)
3. Transaction: delete existing response for this user+boss, insert new response
4. Re-render the embed from DB

### Slash Commands

| Command | Subcommand | Description |
|---------|-----------|-------------|
| `/loot` | `create_posts` | Auto-discover current raid and create posts |
| `/loot` | `delete_post` | Delete a single loot post |
| `/loot` | `delete_posts` | Batch delete by boss IDs |

---

## Domain: EPGP

EPGP priority rankings with officer upload from WoW addon.

### Upload Flow

1. Officer runs `/epgp upload` with a file attachment or text input (addon export format)
2. Bot parses the data and upserts into `epgp_points` table
3. Bot immediately re-renders the 3-message display

### Display (3-Message Architecture)

| Message | Content |
|---------|---------|
| Header | Filter label (if any) + column headers: Name, EP, GP, PR |
| Body | Raider data rows with EP/GP differences |
| Footer | Last upload date, cutoff date |

CSS code block formatting. Updated immediately on upload (no polling needed).

### Filtering

- By tier token: Zenith, Dreadful, Mystic, Venerated
- By armour type: Cloth, Leather, Mail, Plate
- Filter commands return ephemeral response (don't modify the channel display)

### Slash Commands

| Command | Subcommand | Description |
|---------|-----------|-------------|
| `/epgp` | `upload` | Upload EPGP data from addon |
| `/epgp` | `get_by_token` | View rankings filtered by tier token |
| `/epgp` | `get_by_armour` | View rankings filtered by armour type |
| `/epgp` | `create_post` | Create the 3-message display |
| `/epgp` | `update_post` | Manually refresh the display |

---

## Domain: Guild Info

Informational embeds in a dedicated channel.

### Embeds (posted in order)

1. **About Us** - Guild description + link buttons (Raider.io, WoWProgress, WarcraftLogs)
2. **Schedule** - Raid days/times with timezone footer
3. **Recruitment** - Multiple sections with overlord mentions + "Apply Here" button
4. **Achievements** - Manual (expansion 4-5) + live Raider.io data (6+)

### Content Management

All content seeded from `seed.ts` into `guild_info_content`, `guild_info_links`, `achievements_manual` tables on first run. Editable via slash commands.

### Full Refresh

`/guildinfo` deletes all messages in the channel and recreates all 4 embeds in order. Message IDs stored in `guild_info_messages` for future edit-in-place updates.

### Achievements

- Expansion 4-5: from `achievements_manual` table
- Expansion 6+: live from Raider.io (`getRaidStaticData` + `getRaidRankings`)
- Cutting Edge detection: last boss killed before tier end date
- Displayed in reverse chronological order with expansion separators
- Refreshed every 30 minutes (polling - Raider.io has no webhooks)

### Slash Commands

| Command | Subcommand | Description |
|---------|-----------|-------------|
| `/guildinfo` | - | Full refresh of all embeds (admin) |
| `/updateachievements` | - | Refresh achievements only (admin) |

---

## Domain: Settings

Feature toggles for signup alerts.

### Settings

| Key | Purpose |
|-----|---------|
| `alertSignup_Wednesday` | 24-hour reminder for Wednesday raid |
| `alertSignup_Wednesday_48` | 48-hour reminder for Wednesday raid |
| `alertSignup_Sunday` | 24-hour reminder for Sunday raid |
| `alertSignup_Sunday_48` | 48-hour reminder for Sunday raid |

All default to `false` (disabled). Stored in `settings` table. Expandable for future toggles.

### Slash Commands

| Command | Subcommand | Description |
|---------|-----------|-------------|
| `/settings` | `get_setting` | View a setting value |
| `/settings` | `toggle_setting` | Toggle a setting |
| `/settings` | `get_all_settings` | View all settings |

---

## Scheduling Strategy

### Event-Driven (no polling)

| Task | Trigger |
|------|---------|
| Keep application threads alive | `threadUpdate` event |
| Keep trial threads alive | `threadUpdate` event |
| Check review alerts | `setTimeout` scheduled on trial creation |
| Alert promotions | `setTimeout` scheduled on mark-for-promotion |
| Update EPGP display | Immediate after `/epgp upload` |

On bot restart: query DB for pending alerts/promotions and re-schedule `setTimeout` for each.

### Polling (external data, no webhooks)

| Task | Interval | Reason |
|------|----------|--------|
| syncRaiders | ~10m | Raider.io has no webhooks |
| updateAchievements | ~30m | Raider.io has no webhooks |
| updateTrialLogs | ~60m | WarcraftLogs has no push notifications |

### Cron (wall-clock time)

| Task | Schedule | Purpose |
|------|----------|---------|
| alertSignups | `0 19 * * 1,2,5,6` | 7PM Mon/Tue/Fri/Sat |
| alertHighestMythicPlusDone | `0 12 * * 3` | Noon Wednesday |

### Scheduler Wrapper

All polling and cron tasks wrapped with:
- Error catching (log and continue, never crash)
- Overlap prevention (skip if previous run still executing)
- Structured logging with timestamps
- Graceful shutdown on SIGTERM

---

## Auto-Creation

The bot creates any missing channels/categories/forums when needed.

| Resource | Created When | Stored In |
|----------|-------------|-----------|
| Applications category | First application | `config` table |
| Application-log forum | First application | `config` table |
| Forum tags (Active/Accepted/Rejected) | First application | Auto-detected by name |
| `app-{name}` text channel | Each application confirmed | `applications` table |
| Trial-reviews forum | First trial created | `config` table |
| Guild info channel | First `/guildinfo` | `config` table |
| Bot-setup channel | First bot action needing it | `config` table |
| Weekly-check channel | First weekly report | `config` table |
| EPGP rankings channel | First `/epgp create_post` | `config` table |
| Loot channel | First `/loot create_posts` | `config` table |
| Raiders lounge channel | First signup alert | `config` table |

`/setup set_channel` and `/setup set_role` exist for officers to manually point to existing channels/roles. Auto-creation is the fallback.

---

## Services

### Raider.io (no auth)

| Function | Endpoint | Consumers |
|----------|----------|-----------|
| `getGuildRoster()` | `/guilds/profile?fields=members` | Roster sync |
| `getRaidRankings(raidSlug)` | `/raiding/raid-rankings` | Achievements |
| `getRaidStaticData(expansionId)` | `/raiding/static-data` | Achievements, Loot |
| `getWeeklyMythicPlusRuns(region, realm, name)` | `/characters/profile?fields=mythic_plus_previous_weekly_highest_level_runs` | Weekly reports |

### WoW Audit (API secret header)

| Function | Endpoint | Consumers |
|----------|----------|-----------|
| `getUpcomingRaids()` | `/v1/raids?include_past=false` | Signup alerts |
| `getHistoricalData()` | `/v1/historical_data?period={prev}` | Weekly reports |

`getCurrentPeriod()` is internal to the service (fetches `/v1/period`).

### WarcraftLogs (OAuth2 + GraphQL)

| Function | Endpoint | Consumers |
|----------|----------|-----------|
| `getTrialLogs(characterName)` | GraphQL: `guildData.guild.attendance` | Trial review logs |

Token cached with expiry tracking. Refreshed automatically when expired.

### Error Handling

All services throw on failure. No more `.catch(error => error)` returning errors as values. Callers use try/catch.

---

## Slash Command Summary

| Command | Subcommands | Admin |
|---------|-------------|-------|
| `/apply` | 0 | No |
| `/applications` | 8 | Yes (except apply) |
| `/trials` | 6 | Yes |
| `/raiders` | 12 | Yes |
| `/loot` | 3 | Yes |
| `/epgp` | 5 | Yes |
| `/guildinfo` | 0 (top-level) | Yes |
| `/updateachievements` | 0 (top-level) | Yes |
| `/settings` | 3 | Yes |
| `/setup` | 3 (set_channel, set_role, get_config) | Yes |
| `/ping` | 0 | No |
| `/help` | 0 | No |

---

## Key Improvements Over V1

| V1 Problem | V2 Solution |
|-----------|-------------|
| Keyv key-value store, no schema | Real SQL tables with foreign keys and indexes |
| Per-file Keyv instances, no shared DB | `getDatabase()` singleton |
| Hardcoded Discord IDs scattered in code | All IDs in `config` table, set via `/setup` or auto-created |
| Config via JSON file with direct imports | Single `config.ts` module + `.env` |
| Mix of axios + node-fetch | axios only |
| CommonJS, no types | TypeScript strict mode, ESM |
| No error handling on cron tasks | Scheduler wrapper with catch + overlap prevention |
| No error handling on button/modal handlers | Top-level try/catch on all interaction types |
| `remove_overlord` / `remove_overlords` mismatch | Fixed (single source of truth for subcommand names) |
| Loot button: no early return after validation failure | Fixed: early return with ephemeral error |
| `rejectedApplicant`: no interaction reply | Fixed: reply sent in all cases |
| Raider-user messages duplicate on every sync | Fixed: `message_id` tracked per raider |
| WarcraftLogs: new OAuth token every call | Token cached with expiry |
| External EPGP API + backend server (£30/mo) | EPGP data in local SQLite, officer upload via slash command |
| 11 polling tasks running constantly | 5 event-driven, 4 polling, 2 cron |
| JSON data files for guild info content | All content in DB, seeded on first run, editable via commands |
| Channels must exist before bot works | Bot auto-creates missing channels |

---

## Verification Plan

1. **Build:** `npm run build` compiles with no errors
2. **Bot startup:** Bot connects to Discord, registers commands, initializes DB
3. **Auto-creation:** Run `/guildinfo` with no pre-existing channels - verify channel created
4. **Applications:** Full flow: `/apply` -> DM questionnaire -> confirm -> verify text channel + forum post + voting + accept/reject DM
5. **Trials:** Accept an application -> verify trial thread created with alerts
6. **Roster sync:** Wait for sync interval -> verify raiders updated in DB and bot-setup messages posted
7. **Loot:** `/loot create_posts` -> verify per-boss embeds with working buttons
8. **EPGP:** `/epgp upload` -> verify data parsed and display updated
9. **Signup alerts:** Toggle settings on, wait for cron fire time -> verify alert posted
10. **Weekly reports:** Wait for Wednesday noon -> verify M+ and vault reports posted

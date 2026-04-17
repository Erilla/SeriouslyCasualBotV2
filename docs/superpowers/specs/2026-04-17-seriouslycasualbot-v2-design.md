# SeriouslyCasualBot V2 - Design Spec

A Discord bot for the World of Warcraft guild **Seriously Casual** on EU-Silvermoon. Manages guild applications, trial reviews, raid roster syncing, loot priority signups, EPGP rankings, and guild information displays.

This is a ground-up rewrite of V1 (CommonJS, Keyv, no types) with the goals of **reliability**, **simplicity**, and **performance**.

---

## Tech Stack

| Technology | Purpose |
|-----------|---------|
| TypeScript 6.x | Strict mode (default), ESM (default), nodenext module resolution |
| Discord.js v14 | Bot framework (slash commands, buttons, modals, select menus, forums) |
| better-sqlite3 | Synchronous SQLite with WAL mode, foreign keys |
| node-cron | Cron scheduling (for time-of-day tasks only) |
| @napi-rs/canvas | Image generation for achievements display (Rust-based, ARM64 native) |
| dotenv | Environment variable loading |
| tsx | Dev runner (watch mode) |

**Runtime:** Node.js 22 LTS, ESM modules, `.js` extensions in imports. Native `fetch` for all HTTP calls (no axios).

**Embed Style:**
- Color: `Colors.Green` (consistent across all embeds)
- Timestamps: `setTimestamp()` on all embeds
- Footer: bot name on informational embeds

**Discord Intents:**

| Intent | Reason |
|--------|--------|
| `Guilds` | Access guild channels, roles, threads |
| `GuildMembers` | Fetch member list for auto-link name matching |
| `GuildMessages` | Read messages in guild channels (application category scanning) |
| `DirectMessages` | Receive DM responses during application questionnaire |
| `MessageContent` | Read DM message content for questionnaire answers |

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

### Startup Sequence

```
1. Load environment variables (dotenv)
2. Validate config (config.ts - throws if required vars missing)
3. Initialize database (create tables if needed)
4. Run pending migrations (schema_version check)
5. Seed data if empty (first run only)
6. Create Discord client with intents
7. Load command files into client.commands collection
8. Register event handlers (interactionCreate, ready, threadUpdate, messageCreate)
9. Login to Discord gateway
10. On 'ready' event:
    a. Register slash commands with guild (deploy-commands)
    b. Re-schedule pending trial alerts and promote alerts (from DB)
    c. Resume in-progress DM questionnaires (from DB)
    d. Start scheduler (polling tasks + cron tasks)
    e. Run daily backup scheduler
    f. Log startup complete to bot-logs
```

```
docs/
  setup.md              # Server setup, environment variables, first-run guide
  commands.md           # Complete slash command reference (auto-updated)
  architecture.md       # System overview, domain map, data flow
  database.md           # Schema reference, migrations
  services.md           # External API reference (endpoints, auth, error handling)
  deployment.md         # Docker, CI/CD, rollback, monitoring
  contributing.md       # Dev setup, branch strategy, PR flow, testing
```

---

## Environment Variables

```
DISCORD_TOKEN              # Bot token
CLIENT_ID                  # Discord application client ID
GUILD_ID                   # Target guild ID
OFFICER_ROLE_ID            # Officer/admin role ID (different per environment)
WOWAUDIT_API_SECRET        # WoW Audit API authorization token
WARCRAFTLOGS_CLIENT_ID     # WarcraftLogs OAuth2 client ID
WARCRAFTLOGS_CLIENT_SECRET # WarcraftLogs OAuth2 client secret
WARCRAFTLOGS_GUILD_ID      # WarcraftLogs guild ID (486913 for production)
RAIDERIO_GUILD_IDS         # Raider.io guild identifiers (1061585%2C43113 for production)
LOG_LEVEL                  # INFO, DEBUG, WARN, ERROR
NODE_ENV                   # development, production
```

A `.env.example` file is committed to the repo with placeholder values and comments for each variable. The real `.env` is gitignored.

### Startup Validation

`config.ts` validates all required env vars on import. If any required var is missing or empty, it throws immediately with a clear error message listing what's missing. The bot never starts in a partially configured state.

No Redis. No external database. No EPGP backend API.

**Environment behavior:**

| `NODE_ENV` | Guild | Test commands | Description |
|-----------|-------|---------------|-------------|
| `development` | `GUILD_ID` (test server) | Enabled | Local dev, test data commands available |
| `production` | `GUILD_ID` (live server) | Disabled | Production, test commands not registered |

The `.env` file for local dev points `GUILD_ID` to the test server. Production `.env` on the Hetzner VPS points to the live guild. The bot only ever connects to one guild at a time.

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
  region         TEXT NOT NULL DEFAULT 'eu',
  rank           INTEGER,
  class          TEXT,              -- WoW class (fetched from Raider.io, used for EPGP filtering)
  discord_user_id TEXT,            -- NULL if not yet linked, auto-populated from identity map
  message_id     TEXT,             -- raider-setup message ID for this raider (prevents duplication)
  missing_since  TEXT              -- timestamp when raider first went missing from API (NULL = present)
);
```

### raider_identity_map

Permanent memory of character-to-Discord user links. Survives raider removal/re-addition.

```sql
CREATE TABLE raider_identity_map (
  character_name  TEXT PRIMARY KEY,
  discord_user_id TEXT NOT NULL
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
  character_name  TEXT,              -- NULL until first question answered (character name is typically Q1)
  applicant_user_id TEXT NOT NULL,   -- Discord user ID
  status          TEXT NOT NULL DEFAULT 'in_progress',  -- in_progress, submitted, active, accepted, rejected, abandoned
  current_question_id INTEGER REFERENCES application_questions(id),  -- tracks DM progress
  channel_id      TEXT,              -- app-{name} text channel ID (set on submit)
  forum_post_id   TEXT,              -- application-log forum post ID (set on submit)
  thread_id       TEXT,              -- forum thread ID (set on submit)
  started_at      TEXT NOT NULL DEFAULT (datetime('now')),
  submitted_at    TEXT,              -- when user confirmed
  resolved_at     TEXT               -- when accepted/rejected
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

### epgp_effort_points

EP history (time-series). References the shared `raiders` table.

```sql
CREATE TABLE epgp_effort_points (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  raider_id  INTEGER NOT NULL REFERENCES raiders(id),
  points     REAL NOT NULL,
  timestamp  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### epgp_gear_points

GP history (time-series). References the shared `raiders` table.

```sql
CREATE TABLE epgp_gear_points (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  raider_id  INTEGER NOT NULL REFERENCES raiders(id),
  points     REAL NOT NULL,
  timestamp  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### epgp_upload_history

Tracks uploads for last-uploaded date and decay values.

```sql
CREATE TABLE epgp_upload_history (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp        TEXT NOT NULL DEFAULT (datetime('now')),
  decay_percent    REAL NOT NULL DEFAULT 0,
  uploaded_content TEXT            -- raw JSON for replay if needed
);
```

### epgp_loot_history

Loot distribution history per raid date.

```sql
CREATE TABLE epgp_loot_history (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  raider_id       INTEGER NOT NULL REFERENCES raiders(id),
  item_id         TEXT,
  item_string     TEXT NOT NULL,      -- full WoW item string
  gear_points     REAL NOT NULL,
  looted_at       TEXT NOT NULL
);
```

### epgp_config

Message IDs for the 3-message EPGP display and other EPGP settings.

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

1. Bot creates an `applications` record with status `in_progress` and the user's Discord ID
2. Bot DMs the user with questions one at a time from `application_questions` table (ordered by `sort_order`)
3. User responds in DM, bot stores answer in `application_answers` and advances `current_question_id`
4. After all questions: bot shows a summary with Confirm/Cancel buttons
5. **Cancel:** Bot sets status to `abandoned`, sends goodbye message
6. **Timeout:** If no response for 30 minutes, bot sets status to `abandoned`, sends timeout message. User can restart with `/apply`.
7. **Confirm:** Bot sets status to `submitted`, then proceeds to channel + forum post creation (status becomes `active` once posted)

Answers are persisted as they come in - if the bot restarts mid-questionnaire, it can resume from where the user left off by checking `current_question_id`. If a user runs `/apply` while they have an `in_progress` application, the bot resumes the existing one instead of starting fresh.

### Answer Review & Edit

After all questions are answered, the summary message shows each Q&A numbered. Below the summary:

- **Edit** button - Bot asks "Which answer would you like to change? (enter the number)". User replies with a number, bot re-asks that question, user provides a new answer, bot updates `application_answers` and re-displays the summary.
- **Confirm** button - Submit the application
- **Cancel** button - Abandon the application

The user can edit as many answers as they want before confirming. Each edit cycle returns to the summary view.

Officers can see abandoned applications via `/applications view_pending` (which shows all non-resolved applications including in-progress and abandoned).

### On Confirm

1. **Create text channel** `app-{charactername}` in the applications category
   - Permissions: applicant can read/write, overlords can read/write, everyone else denied
   - If applications category doesn't exist, create it
   - Post the full Q&A as the first message (split across multiple messages if needed - see message limits below)
2. **Create forum post** in application-log forum
   - If application-log forum doesn't exist, create it
   - Title: character name
   - Tag: Active (auto-create tag if missing)
   - First message: full Q&A + metadata (date, applicant mention). Use embed description (4096 char limit) for longer content. Split into multiple embeds if needed (up to 10 per message, 6000 chars total).
   - Second message: voting embed with for/neutral/against/kekw buttons (usable by anyone who can see the post)
   - Third message: Accept/Reject buttons (officer-only on click, visible to all)
3. **Store** application record in DB with channel_id, forum_post_id, thread_id
4. **Notify** overlords

### Discord Message Limits

| Type | Limit |
|------|-------|
| Message content | 2000 chars (bots and users alike) |
| Embed description | 4096 chars |
| Embed total (all fields) | 6000 chars per embed |
| Embeds per message | 10 (but 6000 char total across all) |
| Embed field name | 256 chars |
| Embed field value | 1024 chars |
| Fields per embed | 25 |

For long content (Q&A, raider lists, EPGP tables): prefer embeds over plain messages for the higher char limits. Split into multiple messages when a single embed can't hold everything.

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
   - Generate transcript of the `app-{name}` text channel (all messages, formatted with timestamps and authors)
   - Post transcript to the application-log forum thread as a message
   - DM applicant with the (possibly edited) accept message + transcript attached as a text file
   - Remove Active tag, add Accepted tag on forum post
   - Lock the forum thread (prevent further voting/discussion)
   - Delete the `app-{name}` text channel
   - Update application status to `accepted` in DB
   - Create trial review thread (cross-domain bridge)

### Reject Flow

1. Officer clicks Reject button on forum post
2. Bot checks officer role - rejects with ephemeral if not authorized
3. Modal opens with:
   - **Message to applicant** (paragraph, pre-filled with `application_reject` default message from `default_messages` table)
4. On submit:
   - Generate transcript of the `app-{name}` text channel (all messages, formatted with timestamps and authors)
   - Post transcript to the application-log forum thread as a message
   - DM applicant with the (possibly edited) reject message + transcript attached as a text file
   - Remove Active tag, add Rejected tag on forum post
   - Lock the forum thread (prevent further voting/discussion)
   - Delete the `app-{name}` text channel
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
2. Compare against `raiders` table (excluding `ignored_characters`)
3. **Raiders no longer in API:**
   - If `missing_since` is NULL: set `missing_since = now` (first miss, start grace period)
   - If `missing_since` is set and < 24 hours old: do nothing (within grace period)
   - If `missing_since` is set and >= 24 hours old: flag for officer review (post alert once)
   - Raiders are never auto-deleted - officers decide via `/raiders remove` or ignore
4. **Raiders back in API:** clear `missing_since` (they returned, false alarm)
5. **New raiders:** add with `discord_user_id` auto-populated from `raider_identity_map` if a match exists, otherwise NULL
6. For new raiders without a Discord user: post alert to raider-setup channel with user select menu + ignore button
7. Track message ID per raider in `raiders.message_id` to prevent duplication
8. Post sync summary to raider-setup channel

### Identity Map

- When an officer links a raider to a Discord user (via select menu or `/raiders update_raider_user`), the mapping is saved to both `raiders.discord_user_id` and `raider_identity_map`
- When a new raider is added, the bot checks `raider_identity_map` first - if the character name exists, the Discord user ID is auto-linked (no officer action needed)
- The identity map is permanent - it survives raider removal and re-addition

### Auto-Link Suggestions

When a new raider is added without a Discord user (and no identity map match), the bot attempts to auto-match:

1. Fetch all guild members from Discord
2. For each unlinked raider, compare `character_name` (case-insensitive) against:
   - Discord display name
   - Server nickname
   - Discord username
3. If a match is found: post a **suggestion** message in raider-setup with:
   - "Link {characterName} to @{user}?" text
   - Confirm button (applies the link + saves to identity map)
   - Reject button (dismisses the suggestion, falls through to manual flow)
   - Manual select menu (officer picks a different user if the suggestion is wrong)
4. If no match found: fall through to standard missing user alert

### Missing User Alerts

Each unlinked raider (with no auto-link suggestion or after a rejected suggestion) gets one message in raider-setup with:
- User select menu (officer picks the Discord user)
- "Ignore character" button

Message ID stored in `raiders.message_id`. On next sync: if raider now has a user, delete the message. Only create a new message if no `message_id` exists.

### Linking Message Refresh

Unresolved linking messages (both auto-link suggestions and missing user alerts) get stale as they scroll up in the channel. The bot refreshes them to keep them visible:

- During each roster sync, after processing changes, check all raiders with a `message_id` that are still unlinked
- Fetch the last few messages in raider-setup and check if the linking messages are already among them
- Only delete and repost messages that have been pushed up by newer messages
- Update `raiders.message_id` with the new message ID when reposted
- This ensures unresolved alerts are always near the bottom of the channel without unnecessary API calls

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
| `raider:confirm_link:{characterName}:{userId}` | Confirm auto-link suggestion |
| `raider:reject_link:{characterName}` | Reject auto-link suggestion (show manual select) |

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

EPGP (Effort Points / Gear Points) priority rankings. Replaces the external C#/.NET backend entirely - all logic lives in the bot.

### Upload Flow

1. Officer runs `/epgp upload` with a file attachment (JSON from WoW addon)
2. Bot parses the addon's JSON format:
   - `Roster`: `object[][]` where each entry is `["Name-Realm", EP, GP]`
   - `Loot`: `object[][]` where each entry is `[timestamp, "Name-Realm", itemString, GP]`
   - Also includes: `Guild`, `Region`, `Realm`, `Min_ep`, `Base_gp`, `Decay_p`, `Extras_p`, `Timestamp`
3. **Roster processing:**
   - For each roster entry with EP > 0: match to existing raider in `raiders` table (by character name + realm), fetch/update class from Raider.io if missing, store new EP/GP values as time-series entries
4. **Loot processing:**
   - Parse item strings, deduplicate against existing loot history
   - Store loot entries grouped by date
5. Store upload in `epgp_upload_history` (timestamp, decay %, raw JSON)
6. Re-render the 3-message display immediately

### Point Difference Calculation

EP/GP differences are calculated using a cutoff date system:
- **Cutoff date:** Rolling, based on raid days (Wednesday/Sunday at 6PM server time)
  - Mon/Tue: cutoff = previous Sunday 6PM
  - Wed (before 6PM): cutoff = previous Sunday 6PM
  - Wed (after 6PM): cutoff = this Wednesday 6PM
  - Thu/Fri/Sat: cutoff = this Wednesday 6PM
  - Sun (before 6PM): cutoff = this Wednesday 6PM
  - Sun (after 6PM): cutoff = this Sunday 6PM
- **Decay:** On Wednesdays, a decay percentage is applied to pre-cutoff values before calculating the difference
- **Difference = current points - decayed pre-cutoff points**

### Priority Calculation

`Priority = EP / GP` (higher = more deserving of loot). Displayed to 3 decimal places.

### Display (3-Message Architecture)

| Message | Content |
|---------|---------|
| Header | Filter label (if any) + column headers: Name, EP, GP, PR |
| Body | Raider data rows with EP/GP differences, sorted by PR descending |
| Footer | Last upload date, cutoff date |

CSS code block formatting. Updated immediately on upload (no polling needed).

### Filtering

- By tier token: Zenith (Evoker/Monk/Rogue/Warrior), Dreadful (DK/DH/Warlock), Mystic (Druid/Hunter/Mage), Venerated (Paladin/Priest/Shaman)
- By armour type: Cloth (Mage/Priest/Warlock), Leather (DH/Druid/Monk/Rogue), Mail (Evoker/Hunter/Shaman), Plate (DK/Paladin/Warrior)
- Filtering uses the `class` field on `raiders` table (populated from Raider.io during roster sync or EPGP upload)
- Filter commands return ephemeral response (don't modify the channel display)

### Slash Commands

| Command | Subcommand | Description |
|---------|-----------|-------------|
| `/epgp` | `upload` | Upload EPGP data from addon (file attachment) |
| `/epgp` | `get_by_token` | View rankings filtered by tier token (ephemeral) |
| `/epgp` | `get_by_armour` | View rankings filtered by armour type (ephemeral) |
| `/epgp` | `create_post` | Create the 3-message display in channel |
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

### Achievements (Generated Image)

Unlike the other guild info sections (which use embeds), achievements are rendered as a generated PNG image for a cleaner table display.

**Data sources:**
- Expansion 4-5: from `achievements_manual` table
- Expansion 6+: live from Raider.io (`getRaidStaticData` + `getRaidRankings`)
- Cutting Edge detection: last boss killed before tier end date

**Image generation** (using `@napi-rs/canvas`):
1. Query all achievement data (manual + API)
2. Build rows in reverse chronological order with expansion separators
3. Draw table on canvas:
   - Columns: Raid, Progress, World Ranking
   - CE rows highlighted (bold or accent color)
   - Guild-themed styling (green accent matching embed color)
   - Clean monospace font for alignment
4. Export as PNG buffer
5. Attach to message as an image embed with the achievements title

**Refreshed** every 30 minutes (polling - Raider.io has no webhooks). The image is regenerated each time.

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
| Bot-logs channel | First bot log message | `config` table |
| Bot-audit channel | First audit event | `config` table |
| Raider-setup channel | First missing user alert | `config` table |
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
| `/loglevel` | 2 (get, set) | Yes |
| `/status` | 0 | No |
| `/ping` | 0 | No |
| `/help` | 0 | No |
| `/testdata` | 6 | Yes (dev only) |

---

## Key Improvements Over V1

| V1 Problem | V2 Solution |
|-----------|-------------|
| Keyv key-value store, no schema | Real SQL tables with foreign keys and indexes |
| Per-file Keyv instances, no shared DB | `getDatabase()` singleton |
| Hardcoded Discord IDs scattered in code | All IDs in `config` table, set via `/setup` or auto-created |
| Config via JSON file with direct imports | Single `config.ts` module + `.env` |
| Mix of axios + node-fetch | Native fetch (zero HTTP dependencies) |
| CommonJS, no types | TypeScript strict mode, ESM |
| No error handling on cron tasks | Scheduler wrapper with catch + overlap prevention |
| No error handling on button/modal handlers | Top-level try/catch on all interaction types |
| `remove_overlord` / `remove_overlords` mismatch | Fixed (single source of truth for subcommand names) |
| Loot button: no early return after validation failure | Fixed: early return with ephemeral error |
| `rejectedApplicant`: no interaction reply | Fixed: reply sent in all cases |
| Raider-user messages duplicate on every sync | Fixed: `message_id` tracked per raider |
| WarcraftLogs: new OAuth token every call | Token cached with expiry |
| External EPGP API + backend server (£30/mo) | Full EPGP logic in bot: upload parsing, point history, decay calculation, loot tracking, all in SQLite |
| 11 polling tasks running constantly | 5 event-driven, 4 polling, 2 cron |
| JSON data files for guild info content | All content in DB, seeded on first run, editable via commands |
| Channels must exist before bot works | Bot auto-creates missing channels |

---

## Resilience & Error Handling

### Database Transactions

All multi-step database operations use transactions. If any step fails, the entire operation rolls back. Examples:
- EPGP upload (roster + points + loot)
- Application submission (application record + answers + channel/forum IDs)
- Roster sync (add/remove multiple raiders)
- Loot response update (delete old + insert new)

```typescript
const db = getDatabase();
const tx = db.transaction(() => {
  // multiple operations
  // if any throw, all roll back
});
tx();
```

### Discord Rate Limiting

Discord.js v14 handles rate limits automatically via its built-in REST manager. For bulk operations that send many API calls:

- **Guild info refresh** (delete all + send 4 embeds): sequential with awaits, discord.js queues automatically
- **Roster sync alerts** (multiple messages): batch and send with small delays if many new raiders
- **Thread maintenance** (unarchive): discord.js handles 429 retries internally

No custom rate limit code needed - discord.js queues and retries transparently. The bot just needs to `await` each call rather than fire-and-forget.

### External API Resilience

When Raider.io, WoW Audit, or WarcraftLogs is down:

| Trigger | Behavior |
|---------|----------|
| **Scheduled task** (interval/cron) | Log error to bot-logs, skip this run, retry on next scheduled interval. No user-facing message. |
| **User command** (e.g., `/raiders sync_raiders`) | Reply with a clear ephemeral error: "Could not reach Raider.io - the service may be temporarily unavailable. Please try again later." Log to bot-logs. |
| **Partial failure** (e.g., one raider's M+ lookup fails during weekly report) | Continue processing remaining raiders, note the failure in the output, log to bot-logs. |

Services throw typed errors that distinguish between network failures, API errors (4xx/5xx), and parse errors so callers can provide appropriate messages.

### Graceful Shutdown

On SIGTERM/SIGINT:
1. Stop accepting new interactions
2. Cancel pending scheduled tasks and `setTimeout` timers
3. Wait for in-flight database transactions to complete
4. Close database connection
5. Destroy Discord client
6. Exit

In-progress DM questionnaires survive shutdown because state is in the DB - they resume on next startup.

### Pagination

For commands that return long lists, use Discord's embed field limits and pagination buttons:

- **Lists under 2000 chars**: single message
- **Lists over 2000 chars**: paginated with Previous/Next buttons
- Applies to: `/raiders get_raiders`, `/applications view_pending`, `/trials get_current_trials`, EPGP display body
- EPGP display body: if it exceeds 2000 chars, split into multiple body messages (store all message IDs in `epgp_config`)

### Permission System

Officer permissions use a configurable role ID stored in the `config` table:

| Config Key | Development | Production |
|-----------|-------------|------------|
| `officer_role_id` | `1471969793572864183` | `255630010088423425` |

Set via `/setup set_role officer` or seeded from environment. The `requireOfficer(interaction)` helper:
1. Checks `interaction.member.roles.cache.has(officerRoleId)`
2. If not authorized: replies with ephemeral "You do not have permission to use this command"
3. Logs the unauthorized attempt to bot-audit

All admin commands use this check. No hardcoded role IDs anywhere in the codebase.

### Database Migrations

Versioned migration system for schema changes after initial deploy:

- `database/migrations/` directory with numbered files: `001_initial.ts`, `002_add_raider_class.ts`, etc.
- A `schema_version` table tracks which migrations have been applied:
  ```sql
  CREATE TABLE schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  ```
- On startup, `initDatabase()` runs any unapplied migrations in order
- Migrations are forward-only (no rollback scripts) - keep them simple and additive
- Each migration is wrapped in a transaction

---

## Test Data Commands (Development Only)

The `/testdata` command group is only registered when `NODE_ENV=development`. It creates realistic test data in the test server for manual verification.

| Subcommand | Description |
|-----------|-------------|
| `seed_raiders` | Insert mock raiders with character names, realms, some with Discord users linked, some without |
| `seed_application` | Create a fake completed application with answers, forum post, and voting buttons |
| `seed_trial` | Create a trial with review alerts scheduled |
| `seed_epgp` | Insert mock EPGP point history and loot records, render the 3-message display |
| `seed_loot` | Create mock loot posts with boss encounters and some responses |
| `reset` | Drop all data and re-run seed (clean slate for testing) |

These commands are excluded from `deploy-commands.ts` in production - the command file is skipped entirely when `NODE_ENV !== 'development'`.

---

## Logging

### Structured Logger

A `logger.ts` service with levels: `DEBUG`, `INFO`, `WARN`, `ERROR`.

- Set via `LOG_LEVEL` env var (default: `INFO`)
- Can be changed at runtime via `/loglevel set` (officer-only) without restart
- All log entries include: timestamp, level, domain (e.g., `raids`, `applications`), message
- Console output for all levels (visible in `docker compose logs`)
- Discord channel output for `INFO` and above

### `/loglevel` Command

| Subcommand | Description |
|-----------|-------------|
| `get` | Show current log level (ephemeral) |
| `set` | Change log level at runtime (choices: DEBUG, INFO, WARN, ERROR). Officer-only. Logged to bot-audit. |

### Channel Routing

| Channel | What gets logged |
|---------|-----------------|
| **bot-logs** | Operational events: scheduler activity, sync summaries, startup/shutdown, errors, API failures |
| **bot-audit** | Officer actions (see audit trail below) |

### Audit Trail (bot-audit channel)

Every officer action that changes state is logged with who, what, and when:

| Event | Detail logged |
|-------|--------------|
| Application accepted | Officer name, applicant name, trial start date |
| Application rejected | Officer name, applicant name |
| Raider linked to user | Officer name, character name, Discord user |
| Raider ignored | Officer name, character name |
| Auto-link confirmed | Officer name, character name, Discord user |
| Auto-link rejected | Officer name, character name |
| Setting toggled | Officer name, setting key, old value, new value |
| Channel configured | Officer name, channel key, channel name |
| Role configured | Officer name, role key, role name |
| Overlord added/removed | Officer name, overlord name |
| Trial extended/promoted/closed | Officer name, trial character name |
| EPGP data uploaded | Officer name, raider count, loot entry count |
| Question added/removed | Officer name, question text |
| Default message updated | Officer name, message key |

---

## Database Backups

SQLite is a single file. Automated daily backups protect against corruption or data loss.

### Backup Strategy

- Daily backup via cron on the host (outside Docker): `sqlite3 /path/to/db.sqlite ".backup /path/to/backups/db-$(date +%Y%m%d).sqlite"`
- Alternatively, the bot runs a daily backup internally using SQLite's `.backup` API on a scheduler
- Keep last 7 daily backups, delete older ones
- Backup file stored in a separate Docker volume or host directory

### Docker Volume Layout

```yaml
volumes:
  bot-data:      # Live database
  bot-backups:   # Daily backups (last 7 days)
```

### Recovery

To restore from backup:
1. Stop the bot: `docker compose down`
2. Copy backup over live DB: `cp backups/db-YYYYMMDD.sqlite data/db.sqlite`
3. Start the bot: `docker compose up -d`

---

## Bot Status Command

`/status` (available to all users) shows bot health at a glance:

| Field | Value |
|-------|-------|
| Uptime | Time since last restart |
| Last roster sync | Timestamp + result (success/error) |
| Last achievements update | Timestamp + result |
| Last trial logs update | Timestamp + result |
| Next signup alert | Day + time |
| Active applications | Count |
| Active trials | Count |
| Raiders tracked | Count (linked / total) |
| Database size | File size in MB |
| EPGP last upload | Timestamp |

Stored in memory (not DB) - reset on restart, which is fine since it's operational status.

### Slash Commands (updated)

Add to the command summary:

| Command | Subcommands | Admin |
|---------|-------------|-------|
| `/status` | 0 | No |

---

## Testing Strategy

### Unit Tests

Test business logic in isolation with mocked dependencies (Discord client, database, external APIs).

| Domain | What to test |
|--------|-------------|
| Applications | DM questionnaire state machine, vote counting, tag management, permission checks |
| Trial Review | Date calculations (review dates, cutoff), alert scheduling, promotion logic |
| Raids | Roster sync diff algorithm, grace period logic, auto-link matching, identity map lookups |
| Loot | Response update (remove from all + add to new), raider validation, auto-discovery logic |
| EPGP | Upload parsing (roster + loot JSON), point difference calculation, decay logic, cutoff date calculation, tier token / armour type class mapping |
| Guild Info | Achievement building (manual + API), CE detection, embed generation |
| Settings | Toggle logic, default values |
| Scheduler | Overlap prevention, error catching, graceful shutdown |
| Services | Response parsing, error handling, WarcraftLogs token caching |

### Integration Tests

Test against a real SQLite database (in-memory or temp file) and verify end-to-end flows.

| Test | What it verifies |
|------|-----------------|
| Database schema | All tables create successfully, foreign keys enforced, seed data populates |
| Roster sync flow | Insert raiders, run sync with mock API data, verify adds/removes/grace period |
| EPGP upload flow | Parse real addon JSON, verify point history stored, differences calculated correctly |
| EPGP migration | Import from mock PostgreSQL data, verify all records migrated with correct ID mapping |
| Application flow | Create application, store answers, cast votes, accept/reject, verify DB state |
| Trial lifecycle | Create trial, verify alerts scheduled, extend, promote, close |
| Loot response flow | Create post, add responses, switch response, verify DB state and re-render data |

### Test Framework

| Tool | Purpose |
|------|---------|
| vitest | Test runner + assertions |
| vitest (in-source) | Co-located test files (`*.test.ts` alongside source) |

### GitHub Workflows

#### CI (`ci.yml`)

Runs on every push and pull request to `master`.

```yaml
Steps:
  1. Checkout code
  2. Setup Node.js 22
  3. Install dependencies
  4. Lint (eslint)
  5. Type check (tsc --noEmit)
  6. Unit tests (vitest run)
  7. Integration tests (vitest run --project integration)
  8. Build (tsc)
```

#### Deploy (`deploy.yml`)

Runs on push to `master` after CI passes. Builds Docker image, pushes to GitHub Container Registry, deploys to Hetzner CAX11 ARM VPS.

```yaml
Trigger: push to master (after CI passes)

Steps:
  1. Checkout code
  2. Set up Docker Buildx (for ARM64 builds)
  3. Login to GitHub Container Registry (ghcr.io)
  4. Build and push Docker image:
     - Tag: ghcr.io/{owner}/seriouslycasualbot:latest + ghcr.io/{owner}/seriouslycasualbot:{sha}
     - Platform: linux/arm64
  5. SSH into Hetzner VPS:
     - docker compose pull
     - docker compose up -d
     - docker image prune -f (clean old images)

Secrets required:
  - DEPLOY_HOST: Hetzner VPS IP
  - DEPLOY_USER: SSH user (e.g., bot)
  - DEPLOY_SSH_KEY: Private SSH key for authentication
```

#### Dockerfile

```dockerfile
FROM node:22-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
CMD ["node", "dist/index.js"]
```

Multi-stage build: first stage compiles TypeScript, second stage is production-only with no dev dependencies.

#### docker-compose.yml (on server)

```yaml
services:
  bot:
    image: ghcr.io/{owner}/seriouslycasualbot:latest
    restart: unless-stopped
    env_file: .env
    volumes:
      - bot-data:/app/data    # SQLite database persists here
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

volumes:
  bot-data:
```

#### Server Setup (one-time, manual)

Hetzner CAX11 (ARM64, 2 vCPU, 4GB RAM, 40GB disk, €3.79/mo):

1. Create VPS with Ubuntu 24.04 ARM64
2. SSH in, create `bot` user
3. Install Docker + Docker Compose
4. Login to ghcr.io: `docker login ghcr.io`
5. Create `/home/bot/seriouslycasualbot/` with `docker-compose.yml` and `.env`
6. Add SSH public key to `bot` user's authorized_keys
7. Open firewall: SSH only (bot makes outbound connections, no inbound needed)
8. SQLite database created automatically on first bot startup, persisted in Docker volume

#### Rollback

To rollback to a previous version:
```bash
docker compose pull ghcr.io/{owner}/seriouslycasualbot:{previous-sha}
docker compose up -d
```

#### Code Review (`claude-review.yml`)

Runs on pull requests. Claude AI code review.

---

## Development Workflow

### Branch Strategy

- `master` is the protected branch - no direct pushes
- Each implementation task gets its own feature branch (e.g., `feat/foundation`, `feat/applications`, `feat/raids`)
- Work is done in git worktrees where possible to enable parallel implementation of independent tasks
- Each feature branch gets a PR into `master`
- Claude does a thorough code review of each PR before merge

### Vertical Slices

Each feature is developed as a complete vertical slice: schema + business logic + commands + events + tests + docs. This means each slice is independently deployable and testable.

### Parallelism with Worktrees

Independent slices are developed simultaneously in separate git worktrees. Each worktree has its own working directory, its own `node_modules`, and its own SQLite database file - so parallel development doesn't conflict.

| Phase | Slices (can be parallel) | Dependencies |
|-------|------------------------|--------------|
| 1 | Foundation (project setup, DB, config, scheduler, types, CI/CD, Docker) | None |
| 2 | Guild Info, Settings, Raids (roster sync + auto-link + identity map) | Foundation |
| 3 | Applications, Trial Review, Loot, EPGP | Foundation + Raids (for raiders table) |
| 4 | EPGP Migration, polish, final integration tests | All domains |

Within each phase, independent slices run in parallel worktrees.

### Local Environment for Worktrees

Each worktree is a full copy of the repo at a different branch:

```
G:/repos/SeriouslyCasualBotV2/              # main worktree (master)
G:/repos/SeriouslyCasualBotV2-worktrees/
  feat-guild-info/                          # worktree for guild info slice
  feat-settings/                            # worktree for settings slice
  feat-raids/                               # worktree for raids slice
```

Each worktree:
- Has its own `node_modules/` (run `npm install` per worktree)
- Has its own `db.sqlite` (gitignored, created on first run)
- Shares the same `.env` (symlinked or copied)
- Can run `npm run dev` independently

**Only one worktree can run the bot at a time** - Discord only allows one connection per bot token. Development of business logic and tests can happen in parallel across worktrees, but Chrome testing is sequential.

### Chrome Testing Queue

Since only one bot instance can connect to Discord at a time, Chrome verification is sequential:

1. Stop any running bot instance
2. Switch to the worktree being tested: `cd` to worktree, `npm run dev`
3. Test the slice in Chrome against the test Discord server
4. Stop the bot
5. Move to the next slice

Code development (writing logic, tests, running unit tests) happens in parallel across worktrees. Chrome testing is the serialization point - one slice at a time.

### PR Flow

1. Develop feature on branch in worktree
2. Push branch, create PR into `master`
3. CI runs (lint, type check, tests, build)
4. Claude performs thorough code review of the PR
5. Address review feedback
6. Merge to `master`

### Documentation

Documentation lives in `docs/` and is kept up to date as part of every PR:

- **When adding/changing a command:** update `docs/commands.md`
- **When changing the schema:** update `docs/database.md`
- **When changing external API usage:** update `docs/services.md`
- **When changing deployment:** update `docs/deployment.md`
- **When changing architecture:** update `docs/architecture.md`

Documentation updates are part of the PR checklist - Claude's code review should flag missing doc updates.

---

## EPGP Data Migration

One-time migration script to import existing data from the PostgreSQL backend into SQLite.

### Source (PostgreSQL)

| Table | Records to migrate |
|-------|-------------------|
| `Raiders` | Character name, realm, region, class, active status |
| `EffortPoints` | Full time-series (raider ID, points, timestamp) |
| `GearPoints` | Full time-series (raider ID, points, timestamp) |
| `LootHistoryMatch` + `LootHistoryGearPoints` + `ItemString` | Flattened: raider, item string (raw), GP, date |
| `UploadHistory` | Timestamps, uploaded content, decay values |

### Migration Script

A standalone `scripts/migrate-epgp.ts` that:

1. Connects to the PostgreSQL database (connection string passed as env var or argument)
2. Exports raiders, points history, loot history, and upload history
3. Maps PostgreSQL raider IDs to SQLite `raiders` table IDs (matching by character_name + realm)
4. For raiders that exist in EPGP but not in the guild roster: insert into `raiders` with the EPGP data (they may be former members with loot history)
5. Inserts EP/GP time-series, loot history, and upload history into SQLite tables
6. Reports: migrated X raiders, Y EP entries, Z GP entries, W loot entries

### Simplifications

- Item strings stored as raw strings in `epgp_loot_history.item_string` (no normalized bonus IDs / modifiers / relics tables). The full parsing only matters at upload time for deduplication - historical display just needs the raw string.
- `LootHistoryDetailed` (instance/boss names) is dropped - this data was sparsely populated and not displayed by the bot.

---

## Verification Plan

### Manual Testing via Chrome

After each change, verify the affected feature works end-to-end by interacting with the bot through Discord in Chrome (using browser automation tools). This catches issues that unit/integration tests can't: Discord rendering, permission behaviour, button interactions, embed formatting, and real API responses.

**After every change:**
1. Build and run the bot (`npm run dev`)
2. Navigate to the test Discord server in Chrome
3. Test the changed feature by interacting with it as a user would
4. Verify the golden path works
5. Check for regressions in related features

**Feature-specific verification:**

| Feature | What to verify in Chrome |
|---------|-------------------------|
| Bot startup | Bot comes online, commands registered, no errors in bot-logs |
| Auto-creation | Run a command that needs a channel - verify channel created with correct permissions |
| `/apply` flow | Start application, answer questions, edit an answer, confirm - verify DM messages, text channel created, forum post with voting + accept/reject buttons |
| Accept/Reject | Click accept/reject, fill modal, verify DM sent to applicant, tags updated, channel archived |
| Trial creation | Accept an application, verify trial thread created with buttons, overlords added |
| Roster sync | Wait for sync, check raider-setup for auto-link suggestions and missing user alerts |
| Auto-link | Verify suggestion appears, confirm/reject buttons work, identity map updated |
| Loot | `/loot create_posts`, click buttons, verify embed updates with character names |
| EPGP | `/epgp upload`, verify 3-message display updated, test filter commands |
| Guild info | `/guildinfo`, verify all 4 embeds render correctly with buttons and links |
| Settings | Toggle a setting, verify it persists, verify signup alerts respect it |
| `/status` | Check all fields populated correctly |
| Bot-audit | Perform officer actions, verify audit messages appear in bot-audit channel |

### Automated Tests

Unit and integration tests (vitest) run in CI and catch logic/regression bugs. Chrome testing catches UX and Discord-specific issues.

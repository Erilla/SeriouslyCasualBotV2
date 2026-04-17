# Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Set up the project scaffold, database layer, config validation, scheduler, logging, types, and CI/CD pipeline so that all domain slices can build on a working foundation.

**Architecture:** TypeScript 6.x ESM project with Discord.js v14, better-sqlite3 for persistence, node-cron for wall-clock scheduling, and a custom scheduler wrapper for interval tasks with error handling and overlap prevention. Config validated at startup, database initialized with versioned migrations, structured logging to console + Discord channels.

**Tech Stack:** TypeScript 6.x, Discord.js 14, better-sqlite3, node-cron, dotenv, tsx, vitest, Node.js 22 LTS

---

## File Structure

```
package.json
tsconfig.json
.env.example
.prettierrc.json
.eslintrc.json
Dockerfile
docker-compose.yml
vitest.config.ts
src/
  index.ts                    # Entry point: startup sequence
  config.ts                   # Env var loading + validation
  deploy-commands.ts          # Register slash commands to guild
  types/
    index.ts                  # Command, BotEvent, BotClient interfaces
  database/
    db.ts                     # getDatabase() singleton, initDatabase()
    schema.ts                 # All CREATE TABLE statements
    seed.ts                   # Default seed data
    migrations/
      001_initial.ts          # Initial migration (creates all tables)
  scheduler/
    scheduler.ts              # Interval + cron wrapper with overlap/error handling
  services/
    logger.ts                 # Structured logging (console + Discord channel)
    auditLog.ts               # Officer action audit trail
  commands/
    ping.ts                   # /ping command
    help.ts                   # /help command
    status.ts                 # /status command
    setup.ts                  # /setup set_channel, set_role, get_config
    settings.ts               # /settings get, toggle, get_all
    loglevel.ts               # /loglevel get, set
    testdata.ts               # /testdata (dev only)
  events/
    ready.ts                  # On ready: deploy commands, start scheduler
    interactionCreate.ts      # Dispatch hub for commands, buttons, modals, selects
  utils.ts                    # asSendable(), requireOfficer(), pagination helpers
tests/
  unit/
    config.test.ts
    database.test.ts
    scheduler.test.ts
    logger.test.ts
  integration/
    database-schema.test.ts
.github/
  workflows/
    ci.yml
    deploy.yml
    claude-review.yml
docs/
  setup.md
  architecture.md
  database.md
  commands.md
  deployment.md
  contributing.md
  services.md
```

---

### Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.env.example`
- Create: `.prettierrc.json`
- Create: `vitest.config.ts`

- [ ] **Step 1: Initialize package.json**

```bash
cd G:/repos/SeriouslyCasualBotV2
npm init -y
```

Then edit `package.json` to:

```json
{
  "name": "seriouslycasualbot",
  "version": "2.0.0",
  "description": "Discord bot for the WoW guild Seriously Casual on EU-Silvermoon",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js",
    "deploy-commands": "tsx src/deploy-commands.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:integration": "vitest run --project integration",
    "lint": "eslint src/",
    "typecheck": "tsc --noEmit"
  },
  "engines": {
    "node": ">=22.0.0"
  },
  "keywords": [],
  "author": "",
  "license": "UNLICENSED"
}
```

- [ ] **Step 2: Install dependencies**

```bash
npm install discord.js better-sqlite3 node-cron dotenv @napi-rs/canvas
npm install -D typescript @types/better-sqlite3 @types/node tsx vitest eslint @eslint/js typescript-eslint prettier
```

- [ ] **Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2025",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "types": ["node"]
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 4: Create .env.example**

```bash
# Discord Bot
DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=your_client_id_here
GUILD_ID=your_guild_id_here
OFFICER_ROLE_ID=your_officer_role_id_here

# WoW Audit
WOWAUDIT_API_SECRET=your_wowaudit_secret_here

# WarcraftLogs
WARCRAFTLOGS_CLIENT_ID=your_warcraftlogs_client_id_here
WARCRAFTLOGS_CLIENT_SECRET=your_warcraftlogs_client_secret_here
WARCRAFTLOGS_GUILD_ID=486913

# Raider.io
RAIDERIO_GUILD_IDS=1061585%2C43113

# Runtime
LOG_LEVEL=INFO
NODE_ENV=development
```

- [ ] **Step 5: Create .prettierrc.json**

```json
{
  "semi": true,
  "singleQuote": true,
  "tabWidth": 2,
  "trailingComma": "all",
  "printWidth": 100
}
```

- [ ] **Step 6: Create vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
```

- [ ] **Step 7: Create src directory structure**

```bash
mkdir -p src/{types,database/migrations,scheduler,services,commands,events,functions}
mkdir -p tests/{unit,integration}
mkdir -p .github/workflows
mkdir -p docs
```

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json .env.example .prettierrc.json vitest.config.ts
git commit -m "feat: initialize project scaffold with TypeScript 6, Discord.js, SQLite"
```

---

### Task 2: Config Validation

**Files:**
- Create: `src/config.ts`
- Create: `tests/unit/config.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/config.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('config', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('should throw if DISCORD_TOKEN is missing', async () => {
    vi.stubEnv('DISCORD_TOKEN', '');
    vi.stubEnv('CLIENT_ID', 'test');
    vi.stubEnv('GUILD_ID', 'test');
    vi.stubEnv('OFFICER_ROLE_ID', 'test');

    await expect(import('../../src/config.js')).rejects.toThrow('DISCORD_TOKEN');
  });

  it('should export valid config when all required vars are set', async () => {
    vi.stubEnv('DISCORD_TOKEN', 'test-token');
    vi.stubEnv('CLIENT_ID', 'test-client');
    vi.stubEnv('GUILD_ID', 'test-guild');
    vi.stubEnv('OFFICER_ROLE_ID', 'test-role');
    vi.stubEnv('WOWAUDIT_API_SECRET', 'test-secret');
    vi.stubEnv('WARCRAFTLOGS_CLIENT_ID', 'test-wcl-id');
    vi.stubEnv('WARCRAFTLOGS_CLIENT_SECRET', 'test-wcl-secret');
    vi.stubEnv('WARCRAFTLOGS_GUILD_ID', '486913');
    vi.stubEnv('RAIDERIO_GUILD_IDS', '123%2C456');
    vi.stubEnv('LOG_LEVEL', 'INFO');
    vi.stubEnv('NODE_ENV', 'development');

    const { config } = await import('../../src/config.js');

    expect(config.discordToken).toBe('test-token');
    expect(config.clientId).toBe('test-client');
    expect(config.guildId).toBe('test-guild');
    expect(config.officerRoleId).toBe('test-role');
    expect(config.isDevelopment).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/unit/config.test.ts
```

Expected: FAIL - cannot find module `../../src/config.js`

- [ ] **Step 3: Write the implementation**

Create `src/config.ts`:

```typescript
import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, defaultValue: string): string {
  return process.env[name] || defaultValue;
}

export const config = {
  discordToken: required('DISCORD_TOKEN'),
  clientId: required('CLIENT_ID'),
  guildId: required('GUILD_ID'),
  officerRoleId: required('OFFICER_ROLE_ID'),
  wowAuditApiSecret: required('WOWAUDIT_API_SECRET'),
  warcraftLogsClientId: required('WARCRAFTLOGS_CLIENT_ID'),
  warcraftLogsClientSecret: required('WARCRAFTLOGS_CLIENT_SECRET'),
  warcraftLogsGuildId: required('WARCRAFTLOGS_GUILD_ID'),
  raiderIoGuildIds: required('RAIDERIO_GUILD_IDS'),
  logLevel: optional('LOG_LEVEL', 'INFO') as 'DEBUG' | 'INFO' | 'WARN' | 'ERROR',
  nodeEnv: optional('NODE_ENV', 'development'),
  get isDevelopment() {
    return this.nodeEnv === 'development';
  },
  get isProduction() {
    return this.nodeEnv === 'production';
  },
} as const;
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/unit/config.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/unit/config.test.ts
git commit -m "feat: add config module with env var validation"
```

---

### Task 3: Type Definitions

**Files:**
- Create: `src/types/index.ts`

- [ ] **Step 1: Create type definitions**

Create `src/types/index.ts`:

```typescript
import {
  ChatInputCommandInteraction,
  Client,
  Collection,
  SlashCommandBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from 'discord.js';

// ─── Bot Types ───────────────────────────────────────────────

export interface BotClient extends Client {
  commands: Collection<string, Command>;
}

export interface Command {
  data: SlashCommandBuilder | SlashCommandSubcommandsOnlyBuilder;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
  devOnly?: boolean;
}

export interface BotEvent {
  name: string;
  once?: boolean;
  execute: (...args: unknown[]) => Promise<void> | void;
}

// ─── Database Row Types ──────────────────────────────────────

export interface ConfigRow {
  key: string;
  value: string;
}

export interface SettingRow {
  key: string;
  value: number;
}

export interface RaiderRow {
  id: number;
  character_name: string;
  realm: string;
  region: string;
  rank: number | null;
  class: string | null;
  discord_user_id: string | null;
  message_id: string | null;
  missing_since: string | null;
}

export interface RaiderIdentityMapRow {
  character_name: string;
  discord_user_id: string;
}

export interface OverlordRow {
  id: number;
  name: string;
  user_id: string;
}

export interface IgnoredCharacterRow {
  character_name: string;
}

export interface ApplicationRow {
  id: number;
  character_name: string | null;
  applicant_user_id: string;
  status: 'in_progress' | 'submitted' | 'active' | 'accepted' | 'rejected' | 'abandoned';
  current_question_id: number | null;
  channel_id: string | null;
  forum_post_id: string | null;
  thread_id: string | null;
  started_at: string;
  submitted_at: string | null;
  resolved_at: string | null;
}

export interface ApplicationQuestionRow {
  id: number;
  question: string;
  sort_order: number;
}

export interface ApplicationAnswerRow {
  id: number;
  application_id: number;
  question_id: number;
  answer: string;
}

export interface ApplicationVoteRow {
  id: number;
  application_id: number;
  user_id: string;
  vote_type: 'for' | 'neutral' | 'against' | 'kekw';
}

export interface TrialRow {
  id: number;
  character_name: string;
  role: string;
  start_date: string;
  thread_id: string | null;
  logs_message_id: string | null;
  application_id: number | null;
  status: 'active' | 'promoted' | 'closed';
}

export interface TrialAlertRow {
  id: number;
  trial_id: number;
  alert_name: string;
  alert_date: string;
  alerted: number;
}

export interface PromoteAlertRow {
  id: number;
  trial_id: number;
  thread_id: string;
  promote_date: string;
}

export interface LootPostRow {
  id: number;
  boss_id: number;
  boss_name: string;
  boss_url: string | null;
  channel_id: string;
  message_id: string;
}

export interface LootResponseRow {
  id: number;
  loot_post_id: number;
  user_id: string;
  response_type: 'major' | 'minor' | 'wantIn' | 'wantOut';
}

export interface EpgpEffortPointsRow {
  id: number;
  raider_id: number;
  points: number;
  timestamp: string;
}

export interface EpgpGearPointsRow {
  id: number;
  raider_id: number;
  points: number;
  timestamp: string;
}

export interface EpgpUploadHistoryRow {
  id: number;
  timestamp: string;
  decay_percent: number;
  uploaded_content: string | null;
}

export interface EpgpLootHistoryRow {
  id: number;
  raider_id: number;
  item_id: string | null;
  item_string: string;
  gear_points: number;
  looted_at: string;
}

export interface EpgpConfigRow {
  key: string;
  value: string;
}

export interface GuildInfoContentRow {
  key: string;
  title: string | null;
  content: string;
}

export interface ScheduleDayRow {
  id: number;
  day: string;
  time: string;
  sort_order: number;
}

export interface ScheduleConfigRow {
  key: string;
  value: string;
}

export interface GuildInfoMessageRow {
  key: string;
  message_id: string;
}

export interface GuildInfoLinkRow {
  id: number;
  label: string;
  url: string;
  emoji_id: string | null;
}

export interface AchievementsManualRow {
  id: number;
  raid: string;
  progress: string;
  result: string;
  expansion: number;
  sort_order: number;
}

export interface SignupMessageRow {
  id: number;
  message: string;
}

export interface DefaultMessageRow {
  key: string;
  message: string;
}

export interface SchemaVersionRow {
  version: number;
  applied_at: string;
}

// ─── Scheduler Types ─────────────────────────────────────────

export interface ScheduledTask {
  name: string;
  type: 'interval' | 'cron';
  schedule: string | number;
  handler: () => Promise<void>;
  overlap?: boolean;
}

// ─── Logger Types ────────────────────────────────────────────

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
```

- [ ] **Step 2: Verify types compile**

```bash
npx tsc --noEmit src/types/index.ts
```

Expected: No errors (may have import resolution warnings without full project, that's OK)

- [ ] **Step 3: Commit**

```bash
git add src/types/index.ts
git commit -m "feat: add type definitions for all database rows, bot interfaces, scheduler"
```

---

### Task 4: Database Layer

**Files:**
- Create: `src/database/db.ts`
- Create: `src/database/schema.ts`
- Create: `src/database/migrations/001_initial.ts`
- Create: `tests/unit/database.test.ts`
- Create: `tests/integration/database-schema.test.ts`

- [ ] **Step 1: Write the unit test for getDatabase singleton**

Create `tests/unit/database.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { getDatabase, closeDatabase } from '../../src/database/db.js';

describe('database', () => {
  afterEach(() => {
    closeDatabase();
  });

  it('should return a database instance', () => {
    const db = getDatabase(':memory:');
    expect(db).toBeDefined();
    expect(db.open).toBe(true);
  });

  it('should return the same instance on subsequent calls', () => {
    const db1 = getDatabase(':memory:');
    const db2 = getDatabase(':memory:');
    expect(db1).toBe(db2);
  });

  it('should have WAL mode enabled', () => {
    const db = getDatabase(':memory:');
    const result = db.pragma('journal_mode') as { journal_mode: string }[];
    expect(result[0].journal_mode).toBe('wal');
  });

  it('should have foreign keys enabled', () => {
    const db = getDatabase(':memory:');
    const result = db.pragma('foreign_keys') as { foreign_keys: number }[];
    expect(result[0].foreign_keys).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/unit/database.test.ts
```

Expected: FAIL - cannot find module

- [ ] **Step 3: Write the database singleton**

Create `src/database/db.ts`:

```typescript
import Database from 'better-sqlite3';

let db: Database.Database | null = null;

export function getDatabase(path?: string): Database.Database {
  if (db) return db;

  const dbPath = path || process.env.DB_PATH || 'db.sqlite';
  db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/unit/database.test.ts
```

Expected: PASS

- [ ] **Step 5: Create the schema**

Create `src/database/schema.ts`:

```typescript
import type Database from 'better-sqlite3';

export function createTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS raiders (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      character_name  TEXT NOT NULL UNIQUE,
      realm           TEXT NOT NULL DEFAULT 'silvermoon',
      region          TEXT NOT NULL DEFAULT 'eu',
      rank            INTEGER,
      class           TEXT,
      discord_user_id TEXT,
      message_id      TEXT,
      missing_since   TEXT
    );

    CREATE TABLE IF NOT EXISTS raider_identity_map (
      character_name  TEXT PRIMARY KEY,
      discord_user_id TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS overlords (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      name    TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ignored_characters (
      character_name TEXT PRIMARY KEY
    );

    CREATE TABLE IF NOT EXISTS applications (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      character_name      TEXT,
      applicant_user_id   TEXT NOT NULL,
      status              TEXT NOT NULL DEFAULT 'in_progress',
      current_question_id INTEGER REFERENCES application_questions(id),
      channel_id          TEXT,
      forum_post_id       TEXT,
      thread_id           TEXT,
      started_at          TEXT NOT NULL DEFAULT (datetime('now')),
      submitted_at        TEXT,
      resolved_at         TEXT
    );

    CREATE TABLE IF NOT EXISTS application_questions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      question   TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS application_answers (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id  INTEGER NOT NULL REFERENCES applications(id),
      question_id     INTEGER NOT NULL REFERENCES application_questions(id),
      answer          TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS application_votes (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id  INTEGER NOT NULL REFERENCES applications(id),
      user_id         TEXT NOT NULL,
      vote_type       TEXT NOT NULL,
      UNIQUE(application_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS trials (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      character_name  TEXT NOT NULL,
      role            TEXT NOT NULL,
      start_date      TEXT NOT NULL,
      thread_id       TEXT,
      logs_message_id TEXT,
      application_id  INTEGER REFERENCES applications(id),
      status          TEXT NOT NULL DEFAULT 'active'
    );

    CREATE TABLE IF NOT EXISTS trial_alerts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      trial_id   INTEGER NOT NULL REFERENCES trials(id),
      alert_name TEXT NOT NULL,
      alert_date TEXT NOT NULL,
      alerted    INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS promote_alerts (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      trial_id     INTEGER NOT NULL REFERENCES trials(id),
      thread_id    TEXT NOT NULL,
      promote_date TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS loot_posts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      boss_id    INTEGER NOT NULL UNIQUE,
      boss_name  TEXT NOT NULL,
      boss_url   TEXT,
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS loot_responses (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      loot_post_id  INTEGER NOT NULL REFERENCES loot_posts(id),
      user_id       TEXT NOT NULL,
      response_type TEXT NOT NULL,
      UNIQUE(loot_post_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS epgp_effort_points (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      raider_id INTEGER NOT NULL REFERENCES raiders(id),
      points    REAL NOT NULL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS epgp_gear_points (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      raider_id INTEGER NOT NULL REFERENCES raiders(id),
      points    REAL NOT NULL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS epgp_upload_history (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp        TEXT NOT NULL DEFAULT (datetime('now')),
      decay_percent    REAL NOT NULL DEFAULT 0,
      uploaded_content TEXT
    );

    CREATE TABLE IF NOT EXISTS epgp_loot_history (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      raider_id   INTEGER NOT NULL REFERENCES raiders(id),
      item_id     TEXT,
      item_string TEXT NOT NULL,
      gear_points REAL NOT NULL,
      looted_at   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS epgp_config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS guild_info_content (
      key     TEXT PRIMARY KEY,
      title   TEXT,
      content TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS schedule_days (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      day        TEXT NOT NULL,
      time       TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS schedule_config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS guild_info_messages (
      key        TEXT PRIMARY KEY,
      message_id TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS guild_info_links (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      label    TEXT NOT NULL,
      url      TEXT NOT NULL,
      emoji_id TEXT
    );

    CREATE TABLE IF NOT EXISTS achievements_manual (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      raid       TEXT NOT NULL,
      progress   TEXT NOT NULL,
      result     TEXT NOT NULL,
      expansion  INTEGER NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS signup_messages (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      message TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS default_messages (
      key     TEXT PRIMARY KEY,
      message TEXT NOT NULL
    );
  `);
}
```

- [ ] **Step 6: Create the initial migration**

Create `src/database/migrations/001_initial.ts`:

```typescript
import type Database from 'better-sqlite3';
import { createTables } from '../schema.js';

export const version = 1;

export function up(db: Database.Database): void {
  createTables(db);
}
```

- [ ] **Step 7: Add initDatabase to db.ts**

Update `src/database/db.ts` to add initialization:

```typescript
import Database from 'better-sqlite3';
import { createTables } from './schema.js';

let db: Database.Database | null = null;

export function getDatabase(path?: string): Database.Database {
  if (db) return db;

  const dbPath = path || process.env.DB_PATH || 'db.sqlite';
  db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  return db;
}

export function initDatabase(path?: string): Database.Database {
  const database = getDatabase(path);
  createTables(database);
  runMigrations(database);
  return database;
}

export function runMigrations(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = database
    .prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')
    .get() as { version: number } | undefined;

  const currentVersion = applied?.version ?? 0;

  // Migrations will be imported and run in order
  // For now, the initial schema is created by createTables()
  if (currentVersion < 1) {
    database.prepare('INSERT INTO schema_version (version) VALUES (?)').run(1);
  }
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}
```

- [ ] **Step 8: Write integration test for schema**

Create `tests/integration/database-schema.test.ts`:

```typescript
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
    const db = getDatabase();

    // Run again - should not throw
    expect(() => initDatabase(':memory:')).not.toThrow();
  });
});
```

- [ ] **Step 9: Run all tests**

```bash
npx vitest run
```

Expected: All tests pass

- [ ] **Step 10: Commit**

```bash
git add src/database/ tests/unit/database.test.ts tests/integration/database-schema.test.ts
git commit -m "feat: add database layer with schema, migrations, and singleton"
```

---

### Task 5: Seed Data

**Files:**
- Create: `src/database/seed.ts`

- [ ] **Step 1: Create seed data module**

Create `src/database/seed.ts`:

```typescript
import type Database from 'better-sqlite3';

export function seedDatabase(db: Database.Database): void {
  const hasData = db.prepare('SELECT COUNT(*) as count FROM guild_info_content').get() as { count: number };
  if (hasData.count > 0) return; // Already seeded

  const tx = db.transaction(() => {
    // About Us
    db.prepare('INSERT INTO guild_info_content (key, title, content) VALUES (?, ?, ?)').run(
      'aboutus',
      'About Us',
      '**<SeriouslyCasual>** is a two-day Alliance mythic raiding guild. We were founded in 2013 and continue to progress every raid tier at Silvermoon-EU.\n\nOur aim is to obtain every Cutting Edge achievement there is while respecting the fact this game is NOT someone\'s second job.\n\nIf you\'re a fan of banter, memes, and high-end progression, then welcome to your new home.',
    );

    // Achievements title
    db.prepare('INSERT INTO guild_info_content (key, title, content) VALUES (?, ?, ?)').run(
      'achievements_title',
      'Current Progress & Past Achievements',
      '',
    );

    // Recruitment sections
    const recruitmentSections = [
      { key: 'recruitment_who', title: 'Who are we', body: 'A SeriouslyCasual player is one that knows the ins and outs of their class, can consistently perform up to a mythic raiding standard, and enjoys a relaxed social environment. If that sounds like you, then we\'d love to hear from you!' },
      { key: 'recruitment_want', title: 'What We Want From You', body: '- Know everything there is to know about your class at any given time. This includes rotations, use of defensives, consumables, legendaries, specs, enchants, and the like.\n- Be proactive and prepared for every raid encounter. This means researching boss fights.\n- Be mature and friendly. Bonus points if you\'re funny.\n- Attend at least 90% of our scheduled raids within any given tier.\n- Be ready to receive criticism (where its warranted, of course).' },
      { key: 'recruitment_give', title: 'What We Can Give You', body: '- A stable mythic raiding guild with over 9 years of raiding at World of Warcraft\'s highest levels.\n- A platform where you can constantly learn and grow as a player.\n- A great social environment with an active Discord for WoW and even other gaming interests!\n- Memes. So many memes.\n\nIf you\'re an exceptional player and your class isn\'t listed, we still encourage you to apply. Exceptional players will always be considered regardless of class or spec.' },
      { key: 'recruitment_contact', title: 'Need to know more? Contact these guys!', body: 'Contact {{OVERLORDS}} if you have any questions.' },
    ];

    for (const section of recruitmentSections) {
      db.prepare('INSERT INTO guild_info_content (key, title, content) VALUES (?, ?, ?)').run(
        section.key,
        section.title,
        section.body,
      );
    }

    // Schedule
    db.prepare('INSERT INTO schedule_config (key, value) VALUES (?, ?)').run('title', 'Raid Schedule');
    db.prepare('INSERT INTO schedule_config (key, value) VALUES (?, ?)').run('timezone', 'Server Time (CEST +1)');
    db.prepare('INSERT INTO schedule_days (day, time, sort_order) VALUES (?, ?, ?)').run('Wednesday', '20:00 - 23:00', 1);
    db.prepare('INSERT INTO schedule_days (day, time, sort_order) VALUES (?, ?, ?)').run('Sunday', '20:00 - 23:00', 2);

    // Guild info links (About Us buttons)
    db.prepare('INSERT INTO guild_info_links (label, url, emoji_id) VALUES (?, ?, ?)').run(
      'RaiderIO',
      'https://raider.io/guilds/eu/silvermoon/SeriouslyCasual',
      '858702994497208340',
    );
    db.prepare('INSERT INTO guild_info_links (label, url, emoji_id) VALUES (?, ?, ?)').run(
      'WoWProgress',
      'https://www.wowprogress.com/guild/eu/silvermoon/SeriouslyCasual',
      '858703946302750740',
    );
    db.prepare('INSERT INTO guild_info_links (label, url, emoji_id) VALUES (?, ?, ?)').run(
      'Warcraft Logs',
      'https://www.warcraftlogs.com/guild/id/486913',
      '858704238036123688',
    );

    // Manual achievements (expansion 4-5)
    const achievements = [
      { raid: 'Siege of Orgrimmar (10 man)', progress: '14/14HC', result: '**CE** WR 1997', expansion: 4, sort: 1 },
      { raid: 'Highmaul', progress: '7/7M', result: '**CE** WR 1252', expansion: 5, sort: 1 },
      { raid: 'Blackrock Foundry', progress: '8/10M', result: 'WR 1132', expansion: 5, sort: 2 },
      { raid: 'Hellfire Citadel', progress: '13/13M', result: '**CE** WR 1170', expansion: 5, sort: 3 },
    ];

    for (const a of achievements) {
      db.prepare('INSERT INTO achievements_manual (raid, progress, result, expansion, sort_order) VALUES (?, ?, ?, ?, ?)').run(
        a.raid, a.progress, a.result, a.expansion, a.sort,
      );
    }

    // Default application messages
    db.prepare('INSERT INTO default_messages (key, message) VALUES (?, ?)').run(
      'application_accept',
      'Hey there! We would love to offer you a trial spot to raid with SeriouslyCasual. Please message @Warzania (warzania), @Bing (eclipsoid) or @Splo (splosion) on Discord for an invite. You have now been given the Raider role within our Discord that enables several new channels to be viewable. Please make sure to read the #welcome-to-sc channel in the raiders group as soon as possible as this will explain our trial period / raid signups / expectations and required addons. If you have any further questions, please feel free to contact Warzania, Bing or Splo on Discord.',
    );
    db.prepare('INSERT INTO default_messages (key, message) VALUES (?, ?)').run(
      'application_reject',
      'Thank you for your interest in raiding with us. However, in this instance, I\'m afraid we are unable to offer you a raid spot. We wish you luck on your guild search.',
    );

    // Default settings (all disabled)
    const settingKeys = [
      'alertSignup_Wednesday',
      'alertSignup_Wednesday_48',
      'alertSignup_Sunday',
      'alertSignup_Sunday_48',
    ];
    for (const key of settingKeys) {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, 0);
    }
  });

  tx();
}
```

- [ ] **Step 2: Add seed call to initDatabase**

Update `src/database/db.ts` - add import and call after migrations:

```typescript
import Database from 'better-sqlite3';
import { createTables } from './schema.js';
import { seedDatabase } from './seed.js';

let db: Database.Database | null = null;

export function getDatabase(path?: string): Database.Database {
  if (db) return db;

  const dbPath = path || process.env.DB_PATH || 'db.sqlite';
  db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  return db;
}

export function initDatabase(path?: string): Database.Database {
  const database = getDatabase(path);
  createTables(database);
  runMigrations(database);
  seedDatabase(database);
  return database;
}

export function runMigrations(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = database
    .prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')
    .get() as { version: number } | undefined;

  const currentVersion = applied?.version ?? 0;

  if (currentVersion < 1) {
    database.prepare('INSERT INTO schema_version (version) VALUES (?)').run(1);
  }
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}
```

- [ ] **Step 3: Add seed test to integration tests**

Add to `tests/integration/database-schema.test.ts`:

```typescript
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

    // Modify data
    db.prepare("UPDATE guild_info_content SET content = 'modified' WHERE key = 'aboutus'").run();

    // Re-init (simulating restart)
    initDatabase(':memory:');

    const aboutUs = db.prepare("SELECT * FROM guild_info_content WHERE key = 'aboutus'").get() as { content: string };
    expect(aboutUs.content).toBe('modified'); // Should NOT be overwritten
  });
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run
```

Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add src/database/seed.ts src/database/db.ts tests/integration/database-schema.test.ts
git commit -m "feat: add seed data for guild info, schedule, achievements, default messages"
```

---

### Task 6: Logger Service

**Files:**
- Create: `src/services/logger.ts`
- Create: `tests/unit/logger.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/logger.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger } from '../../src/services/logger.js';

describe('Logger', () => {
  let logger: Logger;

  beforeEach(() => {
    logger = new Logger('INFO');
  });

  it('should log INFO messages when level is INFO', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logger.info('raids', 'sync complete');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toContain('[INFO]');
    expect(spy.mock.calls[0][0]).toContain('[raids]');
    expect(spy.mock.calls[0][0]).toContain('sync complete');
    spy.mockRestore();
  });

  it('should not log DEBUG messages when level is INFO', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logger.debug('raids', 'debug detail');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('should log ERROR messages at any level', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logger.error('raids', 'something broke');
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('should allow changing log level at runtime', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logger.setLevel('DEBUG');
    logger.debug('raids', 'now visible');
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/unit/logger.test.ts
```

Expected: FAIL

- [ ] **Step 3: Write the implementation**

Create `src/services/logger.ts`:

```typescript
import type { TextChannel } from 'discord.js';
import type { LogLevel } from '../types/index.js';

const LOG_LEVELS: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

export class Logger {
  private level: LogLevel;
  private discordChannel: TextChannel | null = null;

  constructor(level: LogLevel = 'INFO') {
    this.level = level;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  setDiscordChannel(channel: TextChannel): void {
    this.discordChannel = channel;
  }

  debug(domain: string, message: string): void {
    this.log('DEBUG', domain, message);
  }

  info(domain: string, message: string): void {
    this.log('INFO', domain, message);
  }

  warn(domain: string, message: string): void {
    this.log('WARN', domain, message);
  }

  error(domain: string, message: string, error?: Error): void {
    if (LOG_LEVELS[this.level] <= LOG_LEVELS.ERROR) {
      const timestamp = new Date().toISOString();
      const formatted = `${timestamp} [ERROR] [${domain}] ${message}`;
      console.error(formatted);
      if (error?.stack) {
        console.error(error.stack);
      }
      this.sendToDiscord(formatted).catch(() => {});
    }
  }

  private log(level: LogLevel, domain: string, message: string): void {
    if (LOG_LEVELS[this.level] > LOG_LEVELS[level]) return;

    const timestamp = new Date().toISOString();
    const formatted = `${timestamp} [${level}] [${domain}] ${message}`;

    if (level === 'WARN') {
      console.warn(formatted);
    } else {
      console.log(formatted);
    }

    if (LOG_LEVELS[level] >= LOG_LEVELS.INFO) {
      this.sendToDiscord(formatted).catch(() => {});
    }
  }

  private async sendToDiscord(message: string): Promise<void> {
    if (!this.discordChannel) return;
    try {
      await this.discordChannel.send({ content: `\`\`\`\n${message}\n\`\`\`` });
    } catch {
      // Silently fail - don't recurse if Discord logging fails
    }
  }
}

// Singleton instance
export let logger = new Logger('INFO');

export function initLogger(level: LogLevel): void {
  logger = new Logger(level);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/unit/logger.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/logger.ts tests/unit/logger.test.ts
git commit -m "feat: add structured logger with levels, domain tagging, and Discord output"
```

---

### Task 7: Audit Log Service

**Files:**
- Create: `src/services/auditLog.ts`

- [ ] **Step 1: Create audit log service**

Create `src/services/auditLog.ts`:

```typescript
import type { TextChannel, User } from 'discord.js';
import { logger } from './logger.js';

let auditChannel: TextChannel | null = null;

export function setAuditChannel(channel: TextChannel): void {
  auditChannel = channel;
}

export async function audit(officer: User, action: string, detail: string): Promise<void> {
  const message = `**${officer.displayName}** ${action}: ${detail}`;
  logger.info('audit', message);

  if (!auditChannel) return;

  try {
    await auditChannel.send({ content: message });
  } catch {
    logger.error('audit', 'Failed to send audit log to Discord');
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/services/auditLog.ts
git commit -m "feat: add audit log service for officer action trail"
```

---

### Task 8: Scheduler

**Files:**
- Create: `src/scheduler/scheduler.ts`
- Create: `tests/unit/scheduler.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/scheduler.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Scheduler } from '../../src/scheduler/scheduler.js';

describe('Scheduler', () => {
  let scheduler: Scheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    scheduler = new Scheduler();
  });

  afterEach(() => {
    scheduler.shutdown();
    vi.useRealTimers();
  });

  it('should register and run an interval task', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);

    scheduler.registerInterval({
      name: 'testTask',
      intervalMs: 1000,
      handler,
    });

    scheduler.start();

    await vi.advanceTimersByTimeAsync(1000);
    expect(handler).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('should prevent overlapping executions', async () => {
    let resolveHandler: () => void;
    const handlerPromise = new Promise<void>((resolve) => {
      resolveHandler = resolve;
    });

    const handler = vi.fn().mockReturnValue(handlerPromise);

    scheduler.registerInterval({
      name: 'slowTask',
      intervalMs: 100,
      handler,
    });

    scheduler.start();

    await vi.advanceTimersByTimeAsync(100);
    expect(handler).toHaveBeenCalledTimes(1);

    // Task still running, next tick should skip
    await vi.advanceTimersByTimeAsync(100);
    expect(handler).toHaveBeenCalledTimes(1); // Still 1, not 2

    resolveHandler!();
  });

  it('should catch and log errors without crashing', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('task failed'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    scheduler.registerInterval({
      name: 'failingTask',
      intervalMs: 1000,
      handler,
    });

    scheduler.start();

    await vi.advanceTimersByTimeAsync(1000);
    expect(handler).toHaveBeenCalledTimes(1);

    // Should still run again after failure
    await vi.advanceTimersByTimeAsync(1000);
    expect(handler).toHaveBeenCalledTimes(2);

    consoleSpy.mockRestore();
  });

  it('should stop all tasks on shutdown', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);

    scheduler.registerInterval({
      name: 'testTask',
      intervalMs: 1000,
      handler,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(handler).toHaveBeenCalledTimes(1);

    scheduler.shutdown();

    await vi.advanceTimersByTimeAsync(5000);
    expect(handler).toHaveBeenCalledTimes(1); // No more calls
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/unit/scheduler.test.ts
```

Expected: FAIL

- [ ] **Step 3: Write the implementation**

Create `src/scheduler/scheduler.ts`:

```typescript
import cron from 'node-cron';
import { logger } from '../services/logger.js';

interface IntervalTask {
  name: string;
  intervalMs: number;
  handler: () => Promise<void>;
}

interface CronTask {
  name: string;
  expression: string;
  handler: () => Promise<void>;
}

export class Scheduler {
  private intervals: NodeJS.Timeout[] = [];
  private cronJobs: cron.ScheduledTask[] = [];
  private running: Map<string, boolean> = new Map();

  registerInterval(task: IntervalTask): void {
    const interval = setInterval(async () => {
      if (this.running.get(task.name)) {
        logger.debug('scheduler', `Skipping ${task.name} - still running`);
        return;
      }

      this.running.set(task.name, true);
      const start = Date.now();

      try {
        logger.debug('scheduler', `Running ${task.name}`);
        await task.handler();
        logger.debug('scheduler', `Completed ${task.name} in ${Date.now() - start}ms`);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error('scheduler', `Failed ${task.name}: ${err.message}`, err);
      } finally {
        this.running.set(task.name, false);
      }
    }, task.intervalMs);

    this.intervals.push(interval);
  }

  registerCron(task: CronTask): void {
    const job = cron.schedule(task.expression, async () => {
      if (this.running.get(task.name)) {
        logger.debug('scheduler', `Skipping cron ${task.name} - still running`);
        return;
      }

      this.running.set(task.name, true);
      const start = Date.now();

      try {
        logger.debug('scheduler', `Running cron ${task.name}`);
        await task.handler();
        logger.debug('scheduler', `Completed cron ${task.name} in ${Date.now() - start}ms`);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error('scheduler', `Failed cron ${task.name}: ${err.message}`, err);
      } finally {
        this.running.set(task.name, false);
      }
    });

    this.cronJobs.push(job);
  }

  start(): void {
    logger.info('scheduler', `Started with ${this.intervals.length} intervals and ${this.cronJobs.length} cron jobs`);
  }

  shutdown(): void {
    for (const interval of this.intervals) {
      clearInterval(interval);
    }
    for (const job of this.cronJobs) {
      job.stop();
    }
    this.intervals = [];
    this.cronJobs = [];
    this.running.clear();
    logger.info('scheduler', 'Shut down all tasks');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/unit/scheduler.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/scheduler.ts tests/unit/scheduler.test.ts
git commit -m "feat: add scheduler with interval/cron support, overlap prevention, error handling"
```

---

### Task 9: Utility Helpers

**Files:**
- Create: `src/utils.ts`

- [ ] **Step 1: Create utility module**

Create `src/utils.ts`:

```typescript
import {
  type ChatInputCommandInteraction,
  type Channel,
  type TextChannel,
  type GuildMember,
  ChannelType,
  MessageFlags,
  EmbedBuilder,
  Colors,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { config } from './config.js';
import { audit } from './services/auditLog.js';

/**
 * Narrow a channel to a sendable text channel. Returns null if not sendable.
 */
export function asSendable(channel: Channel | null): TextChannel | null {
  if (!channel) return null;
  if (channel.type === ChannelType.GuildText || channel.type === ChannelType.PublicThread) {
    return channel as TextChannel;
  }
  return null;
}

/**
 * Check if the interaction member has the officer role.
 * Replies with ephemeral error if not authorized.
 * Returns true if authorized, false otherwise.
 */
export async function requireOfficer(interaction: ChatInputCommandInteraction): Promise<boolean> {
  const member = interaction.member as GuildMember;
  if (!member.roles.cache.has(config.officerRoleId)) {
    await interaction.reply({
      content: 'You do not have permission to use this command.',
      flags: MessageFlags.Ephemeral,
    });
    return false;
  }
  return true;
}

/**
 * Create a standard green embed with timestamp.
 */
export function createEmbed(title?: string): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(Colors.Green)
    .setTimestamp()
    .setFooter({ text: 'SeriouslyCasualBot' });
  if (title) embed.setTitle(title);
  return embed;
}

/**
 * Build pagination buttons for lists.
 */
export function paginationRow(currentPage: number, totalPages: number, customIdPrefix: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${customIdPrefix}:prev:${currentPage}`)
      .setLabel('Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage <= 0),
    new ButtonBuilder()
      .setCustomId(`${customIdPrefix}:next:${currentPage}`)
      .setLabel('Next')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage >= totalPages - 1),
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/utils.ts
git commit -m "feat: add utility helpers (asSendable, requireOfficer, createEmbed, pagination)"
```

---

### Task 10: Bot Entry Point & Event Handlers

**Files:**
- Create: `src/index.ts`
- Create: `src/events/ready.ts`
- Create: `src/events/interactionCreate.ts`
- Create: `src/deploy-commands.ts`

- [ ] **Step 1: Create the interaction dispatch hub**

Create `src/events/interactionCreate.ts`:

```typescript
import { type Interaction, MessageFlags } from 'discord.js';
import type { BotClient } from '../types/index.js';
import { logger } from '../services/logger.js';

export default {
  name: 'interactionCreate',
  async execute(...args: unknown[]) {
    const interaction = args[0] as Interaction;

    if (interaction.isChatInputCommand()) {
      const client = interaction.client as BotClient;
      const command = client.commands.get(interaction.commandName);

      if (!command) {
        logger.warn('interaction', `Unknown command: ${interaction.commandName}`);
        return;
      }

      try {
        await command.execute(interaction);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error('interaction', `Command ${interaction.commandName} failed: ${err.message}`, err);

        const reply = { content: 'There was an error executing this command.', flags: MessageFlags.Ephemeral };
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp(reply).catch(() => {});
        } else {
          await interaction.reply(reply).catch(() => {});
        }
      }
    }

    // Button, modal, and select menu handlers will be added by domain slices
  },
};
```

- [ ] **Step 2: Create the ready event handler**

Create `src/events/ready.ts`:

```typescript
import type { Client } from 'discord.js';
import { logger } from '../services/logger.js';
import { Scheduler } from '../scheduler/scheduler.js';

export const scheduler = new Scheduler();

export default {
  name: 'ready',
  once: true,
  async execute(...args: unknown[]) {
    const client = args[0] as Client;
    logger.info('bot', `Logged in as ${client.user?.tag}`);

    // Scheduled tasks will be registered by domain slices
    scheduler.start();

    logger.info('bot', 'Startup complete');
  },
};
```

- [ ] **Step 3: Create deploy-commands**

Create `src/deploy-commands.ts`:

```typescript
import { REST, Routes } from 'discord.js';
import { config } from './config.js';
import { readdirSync } from 'fs';
import { pathToFileURL } from 'url';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { Command } from './types/index.js';
import { logger } from './services/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function deployCommands(): Promise<void> {
  const commands: unknown[] = [];
  const commandsPath = join(__dirname, 'commands');
  const commandFiles = readdirSync(commandsPath).filter((f) => f.endsWith('.js') || f.endsWith('.ts'));

  for (const file of commandFiles) {
    const filePath = join(commandsPath, file);
    const module = await import(pathToFileURL(filePath).href);
    const command = module.default as Command;

    if (command.devOnly && config.isProduction) continue;

    commands.push(command.data.toJSON());
  }

  const rest = new REST().setToken(config.discordToken);

  logger.info('deploy', `Registering ${commands.length} commands to guild ${config.guildId}`);

  await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), {
    body: commands,
  });

  logger.info('deploy', 'Commands registered successfully');
}
```

- [ ] **Step 4: Create the entry point**

Create `src/index.ts`:

```typescript
import { Client, Collection, GatewayIntentBits, Partials } from 'discord.js';
import { config } from './config.js';
import { initDatabase, closeDatabase } from './database/db.js';
import { initLogger, logger } from './services/logger.js';
import { deployCommands } from './deploy-commands.js';
import { scheduler } from './events/ready.js';
import { readdirSync } from 'fs';
import { pathToFileURL } from 'url';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { BotClient, BotEvent, Command } from './types/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Initialize ──────────────────────────────────────────────

initLogger(config.logLevel);
logger.info('bot', 'Starting SeriouslyCasualBot...');

initDatabase();
logger.info('bot', 'Database initialized');

// ─── Create Client ───────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel], // Required for DMs
}) as BotClient;

client.commands = new Collection();

// ─── Load Commands ───────────────────────────────────────────

const commandsPath = join(__dirname, 'commands');
if (readdirSync(commandsPath).length > 0) {
  const commandFiles = readdirSync(commandsPath).filter((f) => f.endsWith('.js'));

  for (const file of commandFiles) {
    const filePath = join(commandsPath, file);
    const module = await import(pathToFileURL(filePath).href);
    const command = module.default as Command;

    if (command.devOnly && config.isProduction) continue;

    client.commands.set(command.data.name, command);
    logger.debug('bot', `Loaded command: ${command.data.name}`);
  }
}

// ─── Load Events ─────────────────────────────────────────────

const eventsPath = join(__dirname, 'events');
const eventFiles = readdirSync(eventsPath).filter((f) => f.endsWith('.js'));

for (const file of eventFiles) {
  const filePath = join(eventsPath, file);
  const module = await import(pathToFileURL(filePath).href);
  const event = module.default as BotEvent;

  if (event.once) {
    client.once(event.name, (...args) => event.execute(...args));
  } else {
    client.on(event.name, (...args) => event.execute(...args));
  }
  logger.debug('bot', `Loaded event: ${event.name}`);
}

// ─── Graceful Shutdown ───────────────────────────────────────

async function shutdown(): Promise<void> {
  logger.info('bot', 'Shutting down...');
  scheduler.shutdown();
  client.destroy();
  closeDatabase();
  logger.info('bot', 'Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ─── Login ───────────────────────────────────────────────────

await client.login(config.discordToken);
```

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/events/ready.ts src/events/interactionCreate.ts src/deploy-commands.ts
git commit -m "feat: add bot entry point, event handlers, deploy-commands, graceful shutdown"
```

---

### Task 11: Core Commands (ping, help, status, setup, settings, loglevel)

**Files:**
- Create: `src/commands/ping.ts`
- Create: `src/commands/help.ts`
- Create: `src/commands/status.ts`
- Create: `src/commands/setup.ts`
- Create: `src/commands/settings.ts`
- Create: `src/commands/loglevel.ts`

- [ ] **Step 1: Create /ping**

Create `src/commands/ping.ts`:

```typescript
import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';

export default {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check bot latency'),
  async execute(interaction: ChatInputCommandInteraction) {
    const sent = await interaction.reply({ content: 'Pinging...', fetchReply: true });
    const latency = sent.createdTimestamp - interaction.createdTimestamp;
    const apiLatency = Math.round(interaction.client.ws.ping);
    await interaction.editReply(`Pong! Latency: ${latency}ms | API Latency: ${apiLatency}ms`);
  },
};
```

- [ ] **Step 2: Create /help**

Create `src/commands/help.ts`:

```typescript
import { SlashCommandBuilder, type ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import type { BotClient } from '../types/index.js';
import { createEmbed } from '../utils.js';

export default {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('List all available commands'),
  async execute(interaction: ChatInputCommandInteraction) {
    const client = interaction.client as BotClient;

    const embed = createEmbed('Available Commands');

    const commandList = client.commands
      .map((cmd) => `\`/${cmd.data.name}\` - ${cmd.data.description}`)
      .join('\n');

    embed.setDescription(commandList || 'No commands loaded.');

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
```

- [ ] **Step 3: Create /status**

Create `src/commands/status.ts`:

```typescript
import { SlashCommandBuilder, type ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { createEmbed } from '../utils.js';
import { getDatabase } from '../database/db.js';
import { logger } from '../services/logger.js';

const startTime = Date.now();

export default {
  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show bot health and status'),
  async execute(interaction: ChatInputCommandInteraction) {
    const db = getDatabase();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = uptime % 60;

    const raiders = db.prepare('SELECT COUNT(*) as total, COUNT(discord_user_id) as linked FROM raiders').get() as { total: number; linked: number };
    const activeApps = db.prepare("SELECT COUNT(*) as count FROM applications WHERE status IN ('in_progress', 'submitted', 'active')").get() as { count: number };
    const activeTrials = db.prepare("SELECT COUNT(*) as count FROM trials WHERE status = 'active'").get() as { count: number };

    const embed = createEmbed('Bot Status')
      .addFields(
        { name: 'Uptime', value: `${hours}h ${minutes}m ${seconds}s`, inline: true },
        { name: 'Log Level', value: logger.getLevel(), inline: true },
        { name: '\u200b', value: '\u200b', inline: true },
        { name: 'Raiders', value: `${raiders.linked}/${raiders.total} linked`, inline: true },
        { name: 'Active Applications', value: `${activeApps.count}`, inline: true },
        { name: 'Active Trials', value: `${activeTrials.count}`, inline: true },
      );

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
```

- [ ] **Step 4: Create /setup**

Create `src/commands/setup.ts`:

```typescript
import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import { getDatabase } from '../database/db.js';
import { requireOfficer } from '../utils.js';
import { audit } from '../services/auditLog.js';

export default {
  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Configure bot channels and roles')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub
        .setName('set_channel')
        .setDescription('Set a channel for a specific purpose')
        .addStringOption((opt) =>
          opt
            .setName('key')
            .setDescription('Channel purpose')
            .setRequired(true)
            .addChoices(
              { name: 'Guild Info', value: 'guild_info_channel_id' },
              { name: 'Bot Logs', value: 'bot_logs_channel_id' },
              { name: 'Bot Audit', value: 'bot_audit_channel_id' },
              { name: 'Raider Setup', value: 'raider_setup_channel_id' },
              { name: 'Weekly Check', value: 'weekly_check_channel_id' },
              { name: 'EPGP Rankings', value: 'epgp_rankings_channel_id' },
              { name: 'Loot', value: 'loot_channel_id' },
              { name: 'Raiders Lounge', value: 'raiders_lounge_channel_id' },
            ),
        )
        .addChannelOption((opt) =>
          opt
            .setName('channel')
            .setDescription('The channel')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('set_role')
        .setDescription('Set a role for a specific purpose')
        .addStringOption((opt) =>
          opt
            .setName('key')
            .setDescription('Role purpose')
            .setRequired(true)
            .addChoices(
              { name: 'Officer', value: 'officer_role_id' },
              { name: 'Raider', value: 'raider_role_id' },
            ),
        )
        .addRoleOption((opt) => opt.setName('role').setDescription('The role').setRequired(true)),
    )
    .addSubcommand((sub) => sub.setName('get_config').setDescription('View all configured channels and roles')),
  async execute(interaction: ChatInputCommandInteraction) {
    if (!(await requireOfficer(interaction))) return;

    const db = getDatabase();
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'set_channel') {
      const key = interaction.options.getString('key', true);
      const channel = interaction.options.getChannel('channel', true);

      db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, channel.id);
      await audit(interaction.user, 'configured channel', `${key} = #${channel.name}`);
      await interaction.reply({ content: `Set **${key}** to ${channel}`, flags: MessageFlags.Ephemeral });
    }

    if (subcommand === 'set_role') {
      const key = interaction.options.getString('key', true);
      const role = interaction.options.getRole('role', true);

      db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, role.id);
      await audit(interaction.user, 'configured role', `${key} = @${role.name}`);
      await interaction.reply({ content: `Set **${key}** to ${role}`, flags: MessageFlags.Ephemeral });
    }

    if (subcommand === 'get_config') {
      const rows = db.prepare('SELECT key, value FROM config ORDER BY key').all() as { key: string; value: string }[];
      const formatted = rows.length > 0
        ? rows.map((r) => `**${r.key}**: \`${r.value}\``).join('\n')
        : 'No configuration set yet.';
      await interaction.reply({ content: `**Bot Configuration:**\n${formatted}`, flags: MessageFlags.Ephemeral });
    }
  },
};
```

- [ ] **Step 5: Create /settings**

Create `src/commands/settings.ts`:

```typescript
import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import { getDatabase } from '../database/db.js';
import { requireOfficer } from '../utils.js';
import { audit } from '../services/auditLog.js';

export default {
  data: new SlashCommandBuilder()
    .setName('settings')
    .setDescription('Manage bot settings')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub
        .setName('get_setting')
        .setDescription('View a setting value')
        .addStringOption((opt) =>
          opt
            .setName('setting_name')
            .setDescription('Setting to view')
            .setRequired(true)
            .addChoices(
              { name: 'Alert Signup Wednesday', value: 'alertSignup_Wednesday' },
              { name: 'Alert Signup Wednesday 48h', value: 'alertSignup_Wednesday_48' },
              { name: 'Alert Signup Sunday', value: 'alertSignup_Sunday' },
              { name: 'Alert Signup Sunday 48h', value: 'alertSignup_Sunday_48' },
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('toggle_setting')
        .setDescription('Toggle a setting on/off')
        .addStringOption((opt) =>
          opt
            .setName('setting_name')
            .setDescription('Setting to toggle')
            .setRequired(true)
            .addChoices(
              { name: 'Alert Signup Wednesday', value: 'alertSignup_Wednesday' },
              { name: 'Alert Signup Wednesday 48h', value: 'alertSignup_Wednesday_48' },
              { name: 'Alert Signup Sunday', value: 'alertSignup_Sunday' },
              { name: 'Alert Signup Sunday 48h', value: 'alertSignup_Sunday_48' },
            ),
        ),
    )
    .addSubcommand((sub) => sub.setName('get_all_settings').setDescription('View all settings')),
  async execute(interaction: ChatInputCommandInteraction) {
    if (!(await requireOfficer(interaction))) return;

    const db = getDatabase();
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'get_setting') {
      const key = interaction.options.getString('setting_name', true);
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: number } | undefined;
      const value = row?.value === 1 ? 'enabled' : 'disabled';
      await interaction.reply({ content: `**${key}** is currently **${value}**`, flags: MessageFlags.Ephemeral });
    }

    if (subcommand === 'toggle_setting') {
      const key = interaction.options.getString('setting_name', true);
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: number } | undefined;
      const current = row?.value ?? 0;
      const newValue = current === 1 ? 0 : 1;
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, newValue);

      const label = newValue === 1 ? 'enabled' : 'disabled';
      await audit(interaction.user, 'toggled setting', `${key}: ${label}`);
      await interaction.reply({ content: `Set **${key}** to **${label}**`, flags: MessageFlags.Ephemeral });
    }

    if (subcommand === 'get_all_settings') {
      const rows = db.prepare('SELECT key, value FROM settings ORDER BY key').all() as { key: string; value: number }[];
      const formatted = rows
        .map((r) => `**${r.key}**: ${r.value === 1 ? 'enabled' : 'disabled'}`)
        .join('\n');
      await interaction.reply({ content: `**All Settings:**\n${formatted || 'No settings found.'}`, flags: MessageFlags.Ephemeral });
    }
  },
};
```

- [ ] **Step 6: Create /loglevel**

Create `src/commands/loglevel.ts`:

```typescript
import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import { logger } from '../services/logger.js';
import { requireOfficer } from '../utils.js';
import { audit } from '../services/auditLog.js';
import type { LogLevel } from '../types/index.js';

export default {
  data: new SlashCommandBuilder()
    .setName('loglevel')
    .setDescription('Get or set the bot log level')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) => sub.setName('get').setDescription('View current log level'))
    .addSubcommand((sub) =>
      sub
        .setName('set')
        .setDescription('Change log level at runtime')
        .addStringOption((opt) =>
          opt
            .setName('level')
            .setDescription('Log level')
            .setRequired(true)
            .addChoices(
              { name: 'DEBUG', value: 'DEBUG' },
              { name: 'INFO', value: 'INFO' },
              { name: 'WARN', value: 'WARN' },
              { name: 'ERROR', value: 'ERROR' },
            ),
        ),
    ),
  async execute(interaction: ChatInputCommandInteraction) {
    if (!(await requireOfficer(interaction))) return;

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'get') {
      await interaction.reply({ content: `Current log level: **${logger.getLevel()}**`, flags: MessageFlags.Ephemeral });
    }

    if (subcommand === 'set') {
      const level = interaction.options.getString('level', true) as LogLevel;
      const oldLevel = logger.getLevel();
      logger.setLevel(level);
      await audit(interaction.user, 'changed log level', `${oldLevel} -> ${level}`);
      await interaction.reply({ content: `Log level changed from **${oldLevel}** to **${level}**`, flags: MessageFlags.Ephemeral });
    }
  },
};
```

- [ ] **Step 7: Commit**

```bash
git add src/commands/
git commit -m "feat: add core commands (ping, help, status, setup, settings, loglevel)"
```

---

### Task 12: CI/CD & Docker

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/deploy.yml`
- Create: `.github/workflows/claude-review.yml`
- Create: `Dockerfile`
- Create: `docker-compose.yml`
- Create: `.dockerignore`

- [ ] **Step 1: Create CI workflow**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [master]
  pull_request:
    branches: [master]

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - run: npm ci

      - name: Type check
        run: npm run typecheck

      - name: Unit tests
        run: npm test

      - name: Build
        run: npm run build
```

- [ ] **Step 2: Create deploy workflow**

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy

on:
  push:
    branches: [master]

jobs:
  ci:
    uses: ./.github/workflows/ci.yml

  deploy:
    needs: ci
    runs-on: ubuntu-latest
    permissions:
      packages: write
      contents: read
    steps:
      - uses: actions/checkout@v4

      - uses: docker/setup-buildx-action@v3

      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          platforms: linux/arm64
          tags: |
            ghcr.io/${{ github.repository_owner }}/seriouslycasualbot:latest
            ghcr.io/${{ github.repository_owner }}/seriouslycasualbot:${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

      - name: Deploy to server
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.DEPLOY_HOST }}
          username: ${{ secrets.DEPLOY_USER }}
          key: ${{ secrets.DEPLOY_SSH_KEY }}
          script: |
            cd ~/seriouslycasualbot
            docker compose pull
            docker compose up -d
            docker image prune -f
```

- [ ] **Step 3: Create Claude review workflow**

Create `.github/workflows/claude-review.yml`:

```yaml
name: Claude Code Review

on:
  pull_request:
    branches: [master]

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Claude Review
        uses: anthropics/claude-code-action@beta
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          model: claude-sonnet-4-20250514
          review_comment_prefix: "claude:"
```

- [ ] **Step 4: Create Dockerfile**

Create `Dockerfile`:

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

- [ ] **Step 5: Create docker-compose.yml**

Create `docker-compose.yml`:

```yaml
services:
  bot:
    image: ghcr.io/${GITHUB_REPOSITORY_OWNER:-local}/seriouslycasualbot:latest
    build: .
    restart: unless-stopped
    env_file: .env
    volumes:
      - bot-data:/app/data
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

volumes:
  bot-data:
```

- [ ] **Step 6: Create .dockerignore**

Create `.dockerignore`:

```
node_modules
dist
.git
.github
.claude
.env
*.sqlite
*.sqlite-*
docs
tests
*.md
```

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/ Dockerfile docker-compose.yml .dockerignore
git commit -m "feat: add CI/CD workflows, Dockerfile, and docker-compose"
```

---

### Task 13: Documentation

**Files:**
- Create: `docs/setup.md`
- Create: `docs/architecture.md`
- Create: `docs/database.md`
- Create: `docs/commands.md`
- Create: `docs/deployment.md`
- Create: `docs/contributing.md`
- Create: `docs/services.md`

- [ ] **Step 1: Create all documentation files**

Create each doc file with the relevant content from the design spec. Each file should cover its specific section:

- `docs/setup.md` - Environment variables, first-run guide, prerequisites
- `docs/architecture.md` - System overview, project structure, domain map, data flow, startup sequence
- `docs/database.md` - Schema reference with all tables, migration system
- `docs/commands.md` - Complete slash command reference (all commands defined so far)
- `docs/deployment.md` - Docker, CI/CD, Hetzner setup, rollback instructions
- `docs/contributing.md` - Dev setup, branch strategy, worktrees, PR flow, testing strategy
- `docs/services.md` - External API reference (Raider.io, WoW Audit, WarcraftLogs endpoints)

- [ ] **Step 2: Commit**

```bash
git add docs/
git commit -m "docs: add setup, architecture, database, commands, deployment, contributing, services docs"
```

---

### Task 14: Build & Smoke Test

- [ ] **Step 1: Run the full build**

```bash
npm run build
```

Expected: No TypeScript errors

- [ ] **Step 2: Run all tests**

```bash
npm test
```

Expected: All unit and integration tests pass

- [ ] **Step 3: Start the bot locally**

```bash
npm run dev
```

Expected: Bot starts, logs "Logged in as SeriouslyCasualTest#...", "Startup complete"

- [ ] **Step 4: Test in Chrome**

Navigate to the test Discord server in Chrome and verify:
- Bot is online
- `/ping` responds with latency
- `/help` lists all commands
- `/status` shows uptime, 0 raiders, 0 applications, 0 trials
- `/setup set_channel` works (pick any channel)
- `/setup get_config` shows the configured channel
- `/settings get_all_settings` shows 4 disabled settings
- `/settings toggle_setting` toggles a setting
- `/loglevel get` shows INFO
- `/loglevel set` changes level

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: foundation complete - bot starts, commands work, DB initialized"
```

- [ ] **Step 6: Create PR**

```bash
git push origin feat/foundation
gh pr create --title "feat: Foundation - project setup, DB, config, scheduler, commands, CI/CD" --body "..."
```

Run Claude review on the PR, address feedback, then merge.

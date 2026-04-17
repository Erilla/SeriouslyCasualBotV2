# Architecture

## Overview

SeriouslyCasualBot is a TypeScript ESM Discord.js v14 bot that manages guild roster, applications, and WoW progression data for the Seriously Casual guild on EU-Silvermoon. It uses a single SQLite database (via better-sqlite3), a cron-based scheduler for background jobs, and a service layer that wraps external WoW APIs (Raider.IO, WoW Audit, WarcraftLogs).

## Project Structure

```
src/
├── index.ts              # Entry point — wires client, loads commands/events
├── config.ts             # Typed env var config with required() validation
├── deploy-commands.ts    # One-shot slash command registration via REST
├── utils.ts              # Shared helpers (asSendable, requireOfficer, loadJson)
├── types/
│   └── index.ts          # Command, BotEvent, BotClient interfaces + DB row types
├── database/
│   ├── db.ts             # Singleton, WAL mode, migrations runner
│   ├── schema.ts         # CREATE TABLE statements (29 tables)
│   ├── seed.ts           # Default data seeding
│   └── migrations/       # Versioned migration files
├── services/
│   ├── logger.ts         # Multi-level logger (console + Discord channel)
│   └── auditLog.ts       # Officer action audit trail to Discord channel
├── scheduler/
│   └── scheduler.ts      # Cron + interval job runner with overlap prevention
├── events/
│   ├── ready.ts          # on Ready — starts scheduler, logs bot info
│   └── interactionCreate.ts  # Routes slash commands to handlers
├── commands/             # One file per slash command
└── functions/            # Business logic grouped by domain
```

## Startup Sequence

1. `initLogger()` — configure log level
2. `initDatabase()` — open SQLite, run schema, run migrations, seed defaults
3. Create `Discord.Client` with required intents
4. Dynamically import all `commands/*.js` files (skip `devOnly` in production)
5. Dynamically import all `events/*.js` files and register listeners
6. Register SIGTERM/SIGINT handlers for graceful shutdown
7. `client.login()` — connect to Discord; `ready` event starts the scheduler

## Domain Overview

- **Config** — env var validation, environment flags
- **Database** — SQLite singleton, schema, migrations, seed
- **Logging** — structured logger, audit log
- **Scheduler** — background jobs with cron expressions and overlap guards
- **Commands** — slash command handlers (ping, help, status, setup, settings, loglevel)
- **Events** — Discord event handlers (ready, interactionCreate)
- **Services** — external API wrappers (WoW Audit, Raider.IO, WarcraftLogs)
- **Functions** — domain business logic (applications, raiders, guild info, etc.)

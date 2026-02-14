# SeriouslyCasualBot V2

A World of Warcraft guild management Discord bot built for **SeriouslyCasual**. Manages raider rosters, guild info embeds, M+ reports, raid signup alerts, and more — all driven by slash commands and automated schedules.

## Tech Stack

- **Runtime** - Node.js 20+, TypeScript, ESM
- **Discord** - discord.js v14
- **Database** - better-sqlite3 (WAL mode)
- **Job queue** - BullMQ + Redis
- **APIs** - Raider.io, WoW Audit, WarcraftLogs, EPGP

## Prerequisites

- [Node.js](https://nodejs.org/) 20 or later
- [Redis](https://redis.io/) 7+ (for BullMQ job scheduling)
- A Discord bot application with a token ([Discord Developer Portal](https://discord.com/developers/applications))

## Getting Started

```bash
# Clone the repository
git clone https://github.com/your-org/SeriouslyCasualBotV2.git
cd SeriouslyCasualBotV2

# Install dependencies
npm install

# Configure environment variables
cp .env.example .env
# Edit .env and fill in your Discord token, client ID, guild ID, etc.

# Register slash commands with Discord
npm run deploy-commands

# Start in development mode (auto-reload)
npm run dev
```

## Docker

A `docker-compose.yml` is included that runs the bot and a Redis instance:

```bash
cp .env.example .env
# Fill in .env

docker compose up -d
```

The bot image is built with a multi-stage Dockerfile (build → production) using `node:20-alpine`.

## Scripts

| Script | Description |
|---|---|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run start` | Run the compiled bot with source maps |
| `npm run dev` | Start in dev mode with auto-reload (tsx watch) |
| `npm run deploy-commands` | Register slash commands to the configured guild |
| `npm run test` | Run unit tests (Vitest) |
| `npm run test:watch` | Run tests in watch mode |
| `npm run test:live` | Run live integration tests |
| `npm run lint` | Lint with ESLint |
| `npm run format` | Format with Prettier |

## Project Structure

```
src/
├── index.ts              # Entry point — loads commands, events, starts scheduler
├── config.ts             # Typed env config
├── deploy-commands.ts    # One-shot slash command registration
├── utils.ts              # Shared helpers (asSendable, loadJson)
├── types/index.ts        # Interfaces & DB row types
├── commands/             # Slash command handlers (one file per command)
├── events/               # Discord event handlers (ready, interactionCreate)
├── database/             # SQLite setup & schema
├── services/             # External API wrappers (Raider.io, WoW Audit, etc.)
└── functions/            # Business logic by domain (guild-info, raids, settings)

data/                     # JSON config files (about us, schedule, recruitment, achievements)
```

## Commands

All commands are guild-scoped. Admin commands require the configured admin role.

| Command | Description | Admin |
|---|---|---|
| `/ping` | Connection test | No |
| `/help` | List all commands | No |
| `/loglevel` | Get or set the bot log level | Yes |
| `/settings` | View or toggle feature settings | Yes |
| `/setup` | Configure channels and roles | Yes |
| `/guildinfo` | Refresh all guild info embeds | Yes |
| `/updateachievements` | Refresh the achievements embed | Yes |
| `/raiders` | Manage raider roster, M+ reports, Great Vault | Yes |

## Configuration

After the bot is running, use `/setup` to configure channels and roles:

**Channels**

| Key | Purpose |
|---|---|
| `guild_info` | Guild info embeds channel |
| `applications_category` | Applications category (legacy) |
| `applications_forum` | Applications forum channel |
| `trial_review_forum` | Trial review forum channel |
| `raiders_lounge` | Signup alerts & M+ reports |
| `loot` | Loot posts channel |
| `priority_loot` | EPGP priority post channel |
| `weekly_check` | Weekly M+/vault reports |
| `bot_setup` | Bot admin area |
| `audit` | Audit log channel |

**Roles**

| Key | Purpose |
|---|---|
| `admin_role` | Admin role for bot commands |
| `raider_role` | Raider role for roster members |

## CI

GitHub Actions runs on every push and pull request to `master`:

1. Install dependencies (`npm ci`)
2. Build (`npm run build`)
3. Run tests (`npm run test`)

## License

Private — not licensed for redistribution.

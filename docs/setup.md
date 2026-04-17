# Setup

## Prerequisites

- Node.js 22 LTS
- npm 10+
- A Discord application with a bot token ([Discord Developer Portal](https://discord.com/developers/applications))

## Installation

```bash
git clone https://github.com/your-org/SeriouslyCasualBotV2.git
cd SeriouslyCasualBotV2
npm install
cp .env.example .env   # then fill in values
```

## First Run

```bash
# Register slash commands with Discord
npm run deploy-commands

# Start in development mode (auto-reload)
npm run dev

# Or build and start in production
npm run build
npm start
```

The bot creates `db.sqlite` on first run and seeds it with default data.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DISCORD_TOKEN` | Yes | Bot token from Discord Developer Portal |
| `CLIENT_ID` | Yes | Discord application client ID |
| `GUILD_ID` | Yes | Target Discord server (guild) ID |
| `OFFICER_ROLE_ID` | Yes | Role ID that grants officer/admin access |
| `WOWAUDIT_API_SECRET` | Yes | WoW Audit API secret key |
| `WARCRAFTLOGS_CLIENT_ID` | Yes | WarcraftLogs OAuth client ID |
| `WARCRAFTLOGS_CLIENT_SECRET` | Yes | WarcraftLogs OAuth client secret |
| `WARCRAFTLOGS_GUILD_ID` | Yes | WarcraftLogs numeric guild ID |
| `RAIDERIO_GUILD_IDS` | Yes | Comma-separated Raider.IO guild IDs |
| `LOG_LEVEL` | No | `DEBUG`, `INFO`, `WARN`, or `ERROR` (default: `INFO`) |
| `NODE_ENV` | No | `development` or `production` (default: `development`) |
| `DB_PATH` | No | SQLite file path (default: `db.sqlite`) |

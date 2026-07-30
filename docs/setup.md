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
| `BLIZZARD_CLIENT_ID` | Yes | Battle.net OAuth application client ID |
| `BLIZZARD_CLIENT_SECRET` | Yes | Battle.net OAuth application client secret |
| `WEEKLY_GEAR_STALE_HOURS` | No | Raider.IO profile crawl age before gear data needs verification (default: `48`) |
| `RAIDERIO_GUILD_IDS` | Yes | Comma-separated Raider.IO guild IDs |
| `GEMINI_API_KEY` | No | Signup-quip generator; falls back to static quips if unset |
| `OPENAI_API_KEY` | No | Additional quip-generator fallback, tried after Gemini |
| `ANTHROPIC_API_KEY` | No | Additional quip-generator fallback, tried after OpenAI |
| `LOG_LEVEL` | No | `DEBUG`, `INFO`, `WARN`, or `ERROR` (default: `INFO`) |
| `NODE_ENV` | No | `development` or `production` (default: `development`) |
| `DB_PATH` | No | SQLite file path (default: `db.sqlite`) |

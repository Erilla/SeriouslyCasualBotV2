# Deployment

The bot runs on [Railway](https://railway.com) — a managed platform that builds
the repo's `Dockerfile` and runs it as an always-on service. Deploys happen
automatically when the connected branch is pushed; there is no server to
provision or SSH into.

Build/restart settings live in `railway.json`. Environment variables and the
persistent volume are configured in the Railway dashboard (not in the repo).

## Railway setup (one-time)

1. **Create the project** — at railway.com: *New Project → Deploy from GitHub
   repo* → select this repo and the branch to deploy (`feat/test-server-deploy`
   for the soak test, or `master`). Railway detects the `Dockerfile` and builds
   it per `railway.json`.

2. **Add a volume for SQLite** — service → *Settings → Volumes* → mount at
   **`/app/data`**. This persists the database and backups across redeploys.

3. **Set environment variables** — service → *Variables*. Use the **sandbox
   guild** values for the test instance:

   | Variable | Notes |
   |---|---|
   | `DISCORD_TOKEN` | Sandbox bot token |
   | `CLIENT_ID` | |
   | `GUILD_ID` | Sandbox guild id |
   | `OFFICER_ROLE_ID` | |
   | `WOWAUDIT_API_SECRET` | |
   | `WARCRAFTLOGS_CLIENT_ID` / `WARCRAFTLOGS_CLIENT_SECRET` | |
   | `WARCRAFTLOGS_GUILD_ID` | e.g. `486913` |
   | `RAIDERIO_GUILD_IDS` | e.g. `1061585%2C43113` |
   | `GEMINI_API_KEY` | optional (static quips fallback if unset) |
   | `LOG_LEVEL` | `INFO` |
   | `NODE_ENV` | `production` |
   | `DB_PATH` | **`/app/data/db.sqlite`** — points SQLite at the volume |

   No public port is needed — the bot is a worker (outbound Discord gateway
   only), so don't generate a domain.

4. **Deploy** — Railway builds and starts the service, and redeploys on every
   push to the connected branch. Watch *Deployments → Logs* for the Discord
   "ready" line.

## Observing / operating

- **Logs & metrics**: the Railway dashboard (*Logs*, *Metrics* for CPU/RAM).
- **Restarts**: `railway.json` sets `restartPolicyType: ON_FAILURE` (max 10
  retries), so a crash auto-recovers.
- **Rollback**: *Deployments* → pick a previous successful deploy → *Redeploy*.

## Local development

`docker-compose.yml` runs the same image locally:

```bash
cp .env.example .env   # fill in values
docker compose up --build
```

The `bot-data` volume persists the local SQLite database.

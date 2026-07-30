# Deployment

The bot runs on [Railway](https://railway.com) — a managed platform that builds
the repo's `Dockerfile` and runs it as an always-on service. Deploys happen
automatically when the connected branch is pushed; there is no server to
provision or SSH into.

Build/restart settings live in `railway.json`. Environment variables and the
persistent volume are configured in the Railway dashboard (not in the repo).

## Branching & environments

Trunk-based: two long-lived branches, each auto-deployed to its own Railway
environment:

| Branch | Railway environment | Guild |
|---|---|---|
| `main` (trunk) | `test` | sandbox guild |
| `prod` (release) | `prod` | live guild |

**Flow:** work lands on `main` (directly or via short-lived feature branches)
→ auto-deploys to **test** for soak testing → when validated, promote with a
fast-forward push:

```sh
git push origin origin/main:prod
```

→ auto-deploys to **production**. `main` and `prod` always share identical
commits (no merge commits, no divergence); `git log prod..main` is exactly
"on test but not yet in prod".

### Release notes

Every promotion triggers `.github/workflows/release.yml`, which tags the promoted
commit `build-N` (N = commit count — the same number the bot logs at startup),
creates a GitHub Release with git-cliff-generated notes (config: `cliff.toml`),
and posts them to `#bot-logs` via the `DISCORD_RELEASE_WEBHOOK` repo secret.
If the secret is missing the Discord post is skipped. Every step soft-fails so
the workflow can never make Railway's Wait-for-CI skip a prod deploy; failures
surface as run annotations and a Discord warning. The Discord post fires when
the workflow finishes, which may be while Railway is still building — a
Railway build failure after a green workflow means the announcement preceded
the deploy. Releases: <https://github.com/Erilla/SeriouslyCasualBotV2/releases>.

One-time setup: create a webhook in `#bot-logs` (channel settings → Integrations →
Webhooks) and store it with `gh secret set DISCORD_RELEASE_WEBHOOK`.

**Guard rails:** CI (`ci.yml`) runs on every push; Railway's *Wait for CI*
holds a deploy until checks pass, so a red push never reaches either
environment (the old build keeps running). A repo ruleset on `prod`
additionally rejects any push whose commit doesn't already have a passing
`ci` check, and blocks force-pushes and deletion on both branches. Each
environment has its own variables (separate Discord tokens, guild IDs, etc.)
and its own volume.

> **Gotcha:** each Railway environment's *trigger branch* is configured in the
> dashboard (environment → service → Settings → Source). The CLI's
> `service source connect` changes the service-level source only and does
> **not** reliably move an environment's trigger — verify with
> `railway deployment list --environment <env> --json` (check `meta.branch`)
> after any change.

## Railway setup (one-time)

1. **Create the project** — at railway.com: *New Project → Deploy from GitHub
   repo* → select this repo and the branch to deploy (`main` for the test
   environment, `prod` for production). Railway detects the `Dockerfile` and
   builds it per `railway.json`.

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
   | `BLIZZARD_CLIENT_ID` | Battle.net OAuth application client ID |
   | `BLIZZARD_CLIENT_SECRET` | Battle.net OAuth application client secret |
   | `WEEKLY_GEAR_STALE_HOURS` | optional; Raider.IO crawl age before gear needs verification (default `48`) |
   | `RAIDERIO_GUILD_IDS` | e.g. `1061585%2C43113` |
   | `GEMINI_API_KEY` | optional (static quips fallback if unset) |
   | `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | optional (further quip fallbacks, tried after Gemini) |
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

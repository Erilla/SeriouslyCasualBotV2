# SeriouslyCasualBot

A Discord bot for the World of Warcraft guild **Seriously Casual** (EU‑Silvermoon). It manages the raid roster, guild applications, trial reviews, loot priority, and guild‑info displays, pulling live data from Raider.IO, WoW Audit, and WarcraftLogs.

Built with TypeScript (ESM), Discord.js v14, and a single SQLite database. Runs on a cron‑based scheduler for background jobs and deploys to Railway via Docker.

## Features

- **Applications** — DM questionnaire, application‑log forum posts with voting, accept/reject flow with transcripts, auto‑creates a trial review thread on accept.
- **Trial review** — per‑trial forum threads with status tags (Active / To Be Promoted / Promoted / Failed), scheduled review alerts, and WarcraftLogs attendance links.
- **Raids / roster** — syncs the roster from Raider.IO, auto‑matches and links raiders to Discord users, missing‑raider alerts, signup reminders, and weekly M+ / Great Vault reports.
- **Loot** — per‑boss loot‑priority posts with reaction buttons for the current raid tier.
- **Guild info** — About Us, Schedule, Recruitment, and a generated Achievements image, refreshed on a schedule.
- **Operational** — structured logging to a Discord channel, an officer audit trail, `/status` health, daily SQLite backups, and forward‑only DB migrations.
- **Migration** — `/migrate` imports data from a V1 database (identity map, overlords, ignored characters, loot posts + votes).

See [`docs/commands.md`](docs/commands.md) for the full slash‑command reference.

## Requirements

- Node.js **>= 22**
- A Discord application + bot token
- API credentials for Raider.IO, WoW Audit, and WarcraftLogs (see below)

## Getting Started

```bash
npm ci
cp .env.example .env   # then fill in the values
npm run deploy-commands   # register slash commands with your guild (run once, and after adding commands)
npm run dev               # start with hot reload (tsx watch)
```

For production:

```bash
npm run build   # compile TypeScript to dist/
npm start       # node dist/index.js
```

## Configuration

Environment variables (see [`.env.example`](.env.example) and [`docs/setup.md`](docs/setup.md)):

| Variable | Required | Notes |
|---|---|---|
| `DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID` | Yes | Discord bot + target guild |
| `OFFICER_ROLE_ID` | Yes | Role gating officer‑only commands |
| `WOWAUDIT_API_SECRET` | Yes | WoW Audit |
| `WARCRAFTLOGS_CLIENT_ID`, `WARCRAFTLOGS_CLIENT_SECRET`, `WARCRAFTLOGS_GUILD_ID` | Yes | WarcraftLogs OAuth2 |
| `RAIDERIO_GUILD_IDS` | Yes | Comma‑separated (URL‑encoded) Raider.IO guild ids |
| `GEMINI_API_KEY` | No | Signup‑quip generator; falls back to static quips if unset |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | No | Additional quip fallbacks, tried in order after Gemini |
| `LOG_LEVEL` | No | `DEBUG` / `INFO` / `WARN` / `ERROR` (default `INFO`) |
| `NODE_ENV` | No | `production` on prod (excludes dev‑only commands); defaults to `development` |

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Run with hot reload (`tsx watch`) |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run the compiled bot |
| `npm run deploy-commands` | Register slash commands with Discord |
| `npm test` | Unit tests (Vitest, `default` project) |
| `npm run test:integration` | Integration tests |
| `npm run test:e2e` | End‑to‑end tests (require a live test guild + `.env.test`) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |

## Testing

```bash
npm test              # unit + integration in the default project (no network)
npm run test:e2e      # e2e — needs .env.test with real Discord ids; excluded from CI
```

CI (GitHub Actions) runs typecheck, lint, the unit test suite, and a build on every push to `main` and `develop`.

## Deployment

Deployed to **Railway** from a Dockerfile. Branch topology:

- `develop` → **test** environment
- `main` → **production**

Promotion is done by opening a PR from `develop` to `main` and squash‑merging. See [`docs/deployment.md`](docs/deployment.md) for details.

## Documentation

| Doc | Contents |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | Project structure, startup sequence, domain overview |
| [`docs/commands.md`](docs/commands.md) | Full slash‑command reference |
| [`docs/setup.md`](docs/setup.md) | Environment and first‑run setup |
| [`docs/database.md`](docs/database.md) | Schema and migrations |
| [`docs/services.md`](docs/services.md) | External API service layer |
| [`docs/deployment.md`](docs/deployment.md) | Railway deployment and promotion flow |
| [`docs/contributing.md`](docs/contributing.md) | Conventions and how to add features |

## License

MIT — see [`LICENSE`](LICENSE).

# External Services

## Raider.IO

Used for guild roster, M+ rankings, and raid progression data.

Base URL: `https://raider.io/api/v1`

| Endpoint | Function | Description | Status |
|---|---|---|---|
| `GET /guilds/profile?fields=members` | `getGuildRoster()` | Fetches full guild roster; filters to rank 0, 1, 3, 4, 5, 7 | Implemented |
| `GET /raiding/raid-rankings` | `getRaidRankings(raidSlug)` | World/region Mythic raid rankings for a given raid tier | Implemented |
| `GET /raiding/static-data` | `getRaidStaticData(expansionId)` | Raid and encounter metadata for a given expansion | Implemented |
| `GET /characters/profile?fields=mythic_plus_previous_weekly_highest_level_runs` | `getWeeklyMythicPlusRuns(region, realm, name)` | Previous week's highest M+ key run for a character | Implemented |

Authentication: none required for public endpoints. Guild IDs configured via `RAIDERIO_GUILD_IDS`.

## WoW Audit

Used for raid sign-ups, attendance, and historical raid data.

Base URL: `https://wowaudit.com/v1`

| Endpoint | Function | Description | Status |
|---|---|---|---|
| `GET /period` | `getCurrentPeriod()` (internal) | Returns the current WoW Audit period number; used internally by `getHistoricalData()` | Implemented |
| `GET /raids?include_past=false` | `getUpcomingRaids()` | Lists upcoming raids with sign-up details (character name, realm, class, status) | Implemented |
| `GET /historical_data?period=<n>` | `getHistoricalData()` | Fetches historical raid data for the previous period; used for Great Vault report generation | Implemented |

Authentication: Bearer token via `WOWAUDIT_API_SECRET`.

## WarcraftLogs

Used for raid log data and performance metrics.

Base URL: `https://www.warcraftlogs.com/api/v2` (GraphQL)

| Query | Function | Description | Status |
|---|---|---|---|
| `guildData.guild.attendance` | `getTrialLogs(characterName)` | Fetches guild attendance and filters to reports where a specific character was present; returns report codes in reverse chronological order | Implemented |
| `reportData.report.rankings` | -- | Boss kill rankings | Placeholder |

Authentication: OAuth2 client credentials via `WARCRAFTLOGS_CLIENT_ID` / `WARCRAFTLOGS_CLIENT_SECRET`. Guild identified by `WARCRAFTLOGS_GUILD_ID`. Tokens are cached with expiry tracking and refreshed automatically.

## LLM providers (signup quips)

`src/services/quipGenerator.ts` generates one-line signup-reminder quips via a
rotating three-provider cascade (raw `fetch`, no SDKs). The starting provider
rotates daily (day-of-year mod 3); each falls through to the next on error,
timeout, or missing key, ending at a static quip corpus that never fails. All
three requests carry a server-side web-search tool (capped at one search) so
the model can reference a current meme.

| Provider | Endpoint | Model | Auth |
|---|---|---|---|
| Gemini | `generativelanguage.googleapis.com/v1beta/...:generateContent` | `gemini-flash-lite-latest` (alias — pinned versions get retired) | `GEMINI_API_KEY` header |
| OpenAI | `api.openai.com/v1/chat/completions` | `gpt-4o-mini-search-preview` | `OPENAI_API_KEY` bearer |
| Claude | `api.anthropic.com/v1/messages` | `claude-haiku-4-5` | `ANTHROPIC_API_KEY` header |

All keys are optional — an unset key skips that provider. The model that served
each quip is logged at `info`.

`src/services/quipContext.ts` derives the guild's current Mythic progression
(prog boss, or reclear mode when the end boss is dead) from the Raider.IO
endpoints above for quip flavour. Best-effort with a 10s overall deadline —
any failure returns `null` and the quip proceeds without it.

---

Service wrappers live in `src/services/`. Each service exports typed async functions consumed by scheduler jobs and command handlers.

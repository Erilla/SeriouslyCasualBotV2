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
| `characterData.character(id:)` | `resolveWclCharacterIds(ids)` | Turns numeric `/character/id/{n}` profile links into `{ region, realm, name }` identities. One aliased batch per call, then a second batch only for canonical IDs the first did not answer — an unrenamed character reports its own ID as `canonicalID`, so following every one blindly would double the point spend | Implemented |
| `reportData.report.rankings` | -- | Boss kill rankings | Placeholder |

Authentication: OAuth2 client credentials via `WARCRAFTLOGS_CLIENT_ID` / `WARCRAFTLOGS_CLIENT_SECRET`. Guild identified by `WARCRAFTLOGS_GUILD_ID`. Tokens are cached with expiry tracking and refreshed automatically.

## Blizzard / Battle.net

Used to retrieve the equipped items that weekly readiness checks inspect for applied enchants and empty sockets, and the achievement fingerprints the applicant-intelligence sweep matches alts on.

Base URL: `https://{region}.api.blizzard.com`

| Endpoint | Function | Description | Status |
|---|---|---|---|
| `GET /profile/wow/character/{realm}/{name}/equipment?namespace=profile-{region}&locale=en_GB` | `getCharacterEquipment(region, realm, name)` | Fetches a character's equipped-item profile | Implemented |
| `GET /data/wow/realm/index?namespace=dynamic-{region}` | `resolveRealmSlug(region, realm)` | Resolves a realm display name **or** an existing slug to Blizzard's canonical slug, cached 7 days per region. Needed because callers supply both forms and Blizzard's own rule deletes hyphens (`Azjol-Nerub` → `azjolnerub`) while keeping them as separators (`Tarren Mill` → `tarren-mill`), which no regex can tell apart. Falls back to the space-to-hyphen rule with a warning when the index is unavailable | Implemented |

Authentication: OAuth2 application credentials via `BLIZZARD_CLIENT_ID` / `BLIZZARD_CLIENT_SECRET`, exchanged at `https://oauth.battle.net/token`. Tokens are cached with expiry tracking and refreshed automatically. The equipment profile is still fetched per raider, but the weekly readiness report no longer emits the `Gear progression` or `Needs verification` sections — the required-enchant slot list was not expansion-accurate (`BACK` takes no enchant this expansion), so both were dropped until the slot rules are corrected. `WEEKLY_GEAR_STALE_HOURS` is consequently unused for now.

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
| OpenAI | `api.openai.com/v1/chat/completions` | `gpt-5-search-api` | `OPENAI_API_KEY` bearer |
| Claude | `api.anthropic.com/v1/messages` | `claude-haiku-4-5` | `ANTHROPIC_API_KEY` header |

All keys are optional — an unset key skips that provider. The model that served
each quip is logged at `info`.

`src/services/quipContext.ts` derives the guild's current Mythic progression
(prog boss, or reclear mode when the end boss is dead) from the Raider.IO
endpoints above for quip flavour. Best-effort with a 10s overall deadline —
any failure returns `null` and the quip proceeds without it.

---

Service wrappers live in `src/services/`. Each service exports typed async functions consumed by scheduler jobs and command handlers.

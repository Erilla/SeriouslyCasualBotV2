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

| Query | Description | Status |
|---|---|---|
| `guildData.guild.attendance` | Attendance records | Placeholder |
| `reportData.report.rankings` | Boss kill rankings | Placeholder |

Authentication: OAuth2 client credentials via `WARCRAFTLOGS_CLIENT_ID` / `WARCRAFTLOGS_CLIENT_SECRET`. Guild identified by `WARCRAFTLOGS_GUILD_ID`.

---

Service wrappers live in `src/services/`. Each service exports typed async functions consumed by scheduler jobs and command handlers.

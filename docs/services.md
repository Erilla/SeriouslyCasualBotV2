# External Services

## Raider.IO

Used for guild roster, M+ rankings, and raid progression data.

Base URL: `https://raider.io/api/v1`

| Endpoint | Description | Status |
|---|---|---|
| `GET /guilds/profile` | Guild profile with roster | Placeholder |
| `GET /mythic-plus/runs` | M+ run history for a character | Placeholder |
| `GET /raiding/progression` | Raid progression tiers | Placeholder |

Authentication: none required for public endpoints. Guild IDs configured via `RAIDERIO_GUILD_IDS`.

## WoW Audit

Used for raid sign-ups, attendance, and historical raid data.

Base URL: `https://wowaudit.com/v1`

| Endpoint | Description | Status |
|---|---|---|
| `GET /raids` | Upcoming and historical raids | Placeholder |
| `GET /raids/:id` | Raid detail with sign-ups | Placeholder |
| `GET /characters` | Guild roster with audit data | Placeholder |

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

Service wrappers live in `src/services/`. Each service exports typed async functions consumed by scheduler jobs and command handlers. Actual endpoint implementations will be documented here as they are built.

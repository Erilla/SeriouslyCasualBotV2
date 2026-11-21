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

## SlashWho (applicant intel, behind a flag)

[SlashWho](https://slashwho.com/) is the maintainer's sibling service that builds applicant dossiers. With
`SLASHWHO_INTEL_ENABLED=true` the applicant-intel job runs through one SlashWho dossier per application
instead of the bot's own sweep; with it off (the default) nothing here is called and the legacy sweep runs
unchanged. The decision and its trade-offs are in
[ADR 0001](adr/0001-slashwho-applicant-intel.md).

Base URL: `SLASHWHO_API_URL` (default `https://slashwho.com`), under `/api/v1`. Contract:
`packages/contracts/src/bot-dossier.ts` in Erilla/SlashWho; a recorded copy of its fixture is in
`tests/fixtures/slashwho/bot-client-v1.json`.

| Endpoint | Function | Description |
|---|---|---|
| `POST /api/v1/dossiers` `{ characters: [url, …] }` (1–10) | `ensureDossier(urls)` | One create from every declared character; the first is the root. Per-character outcomes `queued` / `existing` / `rate_limited` / `suppressed` / `not_found` / `failed`. Called **once per job** — the root is stored and reused on resume, because replaying a create while collecting is charged again |
| `GET /api/v1/dossiers/{region}/{realm}/{name}/status` | `getStatus(root)` | The cheap poll: `state` (`collecting` / `ready` / `partial`) and `snapshotId` |
| `GET /api/v1/dossiers/{region}/{realm}/{name}` | `getDossier(root)` | The chat-sized summary: characters with source, guild spans, the five most recent raids with a kill, Cutting Edge, limitations. Published only when its `snapshotId` matches the status read |
| `POST /api/v1/dossiers/{region}/{realm}/{name}/characters` `{ characterUrl }` | `addDossierCharacter(root, url)` | Links a character pasted into the thread mid-run, or retries a rate-limited create outcome |
| `POST /api/v1/dossiers/{region}/{realm}/{name}/refresh` | `refreshDossier(root)` | Re-collects; the only read-side call that spends provider budget. Implemented, not called by the bot today |

Authentication: `Authorization: Bearer <SLASHWHO_BOT_API_KEY>`; a missing or wrong key is `401`. Startup
fails if the flag is on and the key is not set.

Quotas (SlashWho's bot bucket): **60 searches/hour** (a create or add-character is charged one per character
that queues or joins a run; a fresh snapshot is free) and **300 reads/minute** (status and summary). A `429`
carries `Retry-After` and pauses the job exactly like the other providers. Requests go through
`httpRequest('slashwho', …)`, so the `slashwho` breaker and health counters cover them.

Only Raider.IO character URLs are sent — never a Discord id, handle, message id or application id.

| Variable | Default | Notes |
|---|---|---|
| `SLASHWHO_INTEL_ENABLED` | `false` | Selects the SlashWho runner |
| `SLASHWHO_API_URL` | `https://slashwho.com` | No trailing slash |
| `SLASHWHO_BOT_API_KEY` | — | Required when the flag is on |
| `SLASHWHO_POLL_INTERVAL_MS` | `5000` | Minimum 1000 |
| `SLASHWHO_JOB_DEADLINE_MS` | `600000` | Publish what exists and stop waiting |
| `SLASHWHO_FALLBACK_SWEEP` | `false` | On a SlashWho failure, run the legacy sweep instead of publishing "unavailable". Off by default because the bot and SlashWho share Warcraft Logs credentials, so a fallback double-spends one budget |

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
(prog boss, or reclear mode once the raid is cleared) from the Raider.IO
endpoints above for quip flavour. It selects the main tier by encounter count
among concurrently-active raids — Raider.IO gives side raids the same
far-future end date — so a cleared one-boss side raid can't masquerade as the
current tier. Best-effort with a 10s overall deadline — any failure returns
`null` and the quip proceeds without it.

The signup alert supplies the unsigned count, Overlord names, and progression
only on a subset of alerts (roughly one third, one third, and one half), which
makes it less likely that consecutive reminders restate the same facts. The
prompt forbids retaliation framing and repeated openings/phrases, and a
post-generation style check rejects a provider quip that opens with a number /
"Oi" / "Just one" or contains retaliation phrasing. It does not compare
against the recent-quips list.

---

Service wrappers live in `src/services/`. Each service exports typed async functions consumed by scheduler jobs and command handlers.

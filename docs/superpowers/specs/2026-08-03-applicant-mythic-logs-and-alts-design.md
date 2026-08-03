# Applicant Mythic Logs and Alt Discovery

**Date:** 2026-08-03
**Status:** Design

## Summary

When an application is submitted, the bot posts two follow-up messages to the application
forum thread:

1. **Mythic raid logs** for the applicant's character — the deepest Mythic bosses reached in
   each of up to five recent raid tiers, wipes included, one report link per boss.
2. **Alts** — other characters on the same Battle.net account, discovered without asking the
   applicant, each with its guild, and Mythic logs for the two most raid-active alts.

Both run in the background after the forum post exists. Neither can fail the application.

## Motivation

`getTrialLogs` (`src/services/warcraftlogs.ts`) reads our own guild's WCL attendance, so it
only works for people who have already raided with us. Reviewers assessing an applicant have
no automated view of that applicant's raid history, and no view at all of characters other
than the one they linked.

## Feature 1: Applicant Mythic Logs

### Scope

- **Mythic difficulty only** (WCL `difficulty: 5`). Heroic, Normal and LFR are ignored.
- **Raid zones only.** Mythic+, Delves and trash pulls are excluded.
- **Last three expansions**, derived from the WCL zone catalogue rather than hardcoded.
- **Wipes count.** A wipe on a later boss ranks above a kill on an earlier one.

### Character identity

`parseRaiderIoCharacterName` (`src/functions/applications/raiderIoName.ts`) matches
`raider.io/characters/<region>/<realm>/<name>` but captures only the name. WCL needs all
three.

Widen it to `parseRaiderIoCharacter` returning `{ region, realm, name }` — the regex groups
already exist. Keep a name-only wrapper so `deriveCharacterNameFromAnswers` and its existing
tests are unaffected. Region is uppercased for WCL (`EU`); the realm slug passes through
unchanged.

If no Raider.IO URL is present in the answers, both features no-op. The existing
Discord-display-name fallback is not a character identity and cannot be looked up.

### Algorithm

1. **Zone catalogue.** Query `worldData.expansions`. Keep zones belonging to the three
   highest expansion IDs where `difficulties` contains id 5, excluding:
   - `id >= 500` — these are "Complete Raids (…)" rollups, not real zones
   - names matching PTR / Beta / Dummy Dome
   - zones with fewer than two encounters

   A zone's `encounters` array is in boss order; the array index is the boss's depth. Cache
   this per process — it changes only on patch day.

2. **Candidate reports.** Page `characterData.character.recentReports(limit: 100)` until
   `has_more_pages` is false. Keep reports whose `zone.id` is in the catalogue.

3. **Tier selection.** Group candidates by zone, sort each group newest-first, and take the
   five tiers with the most recent activity.

4. **Fights pass.** For each candidate report, query
   `fights(killType: All, difficulty: 5)`. Filter to `encounterID`s present in that zone's
   catalogue — necessary because raid reports also contain Mythic+ fights and trash fights
   with `difficulty: null`. Accumulate per boss: kill count, wipe count, and the lowest
   `fightPercentage` seen.

5. **Selection.** Within a tier, rank bosses by depth descending. Walk the ranking taking one
   report per boss, skipping any report already linked for a deeper boss, and stop at three
   links. A single report covering bosses 6–8 therefore produces one link, not three.

Requests are sequential — the repo has no concurrency helper and this runs in the background.
A hard cap of 120 requests per applicant guards against a runaway.

### Cost

Measured against the live API:

| Query                       | Cost        |
| --------------------------- | ----------- |
| Zone catalogue              | ~19 points  |
| `recentReports` page of 100 | ~2 points   |
| `fights` for one report     | ~2–3 points |

The rate limit is 9,000 points/hour. A heavy applicant (374 reports, 90 of them raids) costs
roughly 250 points and about 45 seconds of wall clock.

### Output

Posted as a follow-up message to the application thread, mirroring how
`createTrialReviewThread` posts `generateTrialLogsContent`:

```
**Mythic raid logs — Nnoggie**

**Manaforge Omega** *(The War Within)*
6/8 **Fractillus** — 1 kill · [report](https://www.warcraftlogs.com/reports/…)

**Liberation of Undermine** *(The War Within)*
6/8 **One-Armed Bandit** — wiping, best 0.7% · [report](…)
4/8 **Rik Reverb** — 2 kills · [report](…)
```

With no Mythic history, the message is explicit rather than absent:
`No Mythic raid logs found for **X** in the last 3 expansions.` Silence would be ambiguous to
a reviewer.

## Feature 2: Alt Discovery

No question is added to the application. Alts are discovered from data the applicant has
already given us: their Raider.IO character URL and their Discord account.

### Source 1 — Raider.IO claimed characters (primary)

Raider.IO's internal API supports a direct character → user → characters lookup, publicly and
unauthenticated. Two requests:

1. `GET https://raider.io/api/characters/{region}/{realm}/{name}?season=<current>` →
   `characterDetails.user.name` is the owning Raider.IO username. The same payload carries
   `characterCustomizations` with `isClaimed`, `discord_profile` and `bnet_battletag`.
2. `GET https://raider.io/api/user/view-characters?name=<username>` → every claimed character
   with level, class, realm, region, `itemLevelEquipped` and `raidProgress`.

Measured on a live applicant: `Hitoshura-Ravencrest` → user `Zenfu` → **25 characters across
6 realms**, in about a second.

`characterDetails.user` is absent when the owner's privacy settings hide it, even though
`isClaimed` is true — observed on both `Skadimg-Silvermoon` and `Driptinus-Argent Dawn`. When
that happens, two cheap guesses are attempted against `view-profile`: the `discord_profile`
value and the character's own name, each accepted only if the returned profile's
`discord_profile` matches. Both guesses failed for Driptinus (no user `Ictinus`, no user
`Driptinus`), so this tier is low-yield and must not delay the fallback.

Where `discord_profile` is present it is recorded in the output and used to corroborate
fingerprint matches — for Driptinus it independently confirmed one of the three.

These are undocumented internal endpoints with no stability guarantee. They must fail soft
and must never prevent source 2 from running. They get their own `apiHealth` service key
(`raiderio-internal`) so a breakage cannot open the circuit for the documented Raider.IO API
that `getGuildRoster` and the achievements image depend on.

### Source 2 — Blizzard achievement fingerprint (fallback)

Runs **only when source 1 returns nothing** — no claimed user, privacy-hidden owner, or the
internal endpoints failing. On the Hitoshura sample source 1 found 25 alts in 2 requests while
a full fingerprint sweep of the same applicant found 1 in 417, so running both unconditionally
would spend minutes of Blizzard calls to add nothing.

Account-wide achievements share an identical `completed_timestamp` across every character on
the account. Comparing two characters' `{achievementId → completed_timestamp}` maps therefore
identifies same-account characters.

Validated against the live guild roster (30 characters, 435 pairs):

```
5335 identical / 6395 common (83.4%)  Mangashift <-> Skadimg
5242 identical / 6088 common (86.1%)  Skâdi      <-> Skadimg
2852 identical / 3886 common (73.4%)  Katzeth    <-> Kázeth
2324 identical / 3505 common (66.3%)  Tämmy      <-> Alyïssa

distribution: min 0 | p50 6 | p90 99 | p99 3465 | max 5335
```

Unrelated characters share a median of 6 identical timestamps out of ~4,000 in common
(~0.15%); same-account characters share 50–86%. Nothing in the sample fell between 99 and
2,043.

A second validation against an unrelated applicant (Hitoshura-Ravencrest, guild `Goodlife`,
429 members across 21 realms) found exactly one alt in a full-roster sweep:

```
45.0%  2069/4600  Gorre-Outland          ← match
 1.6%    34/2121  Jihoonmonk-Tarren Mill
 1.5%    24/1599  Milespriest-Draenor
distribution across 417 scanned: min 0.00 | p50 0.00 | max 44.98
```

A third sample (Driptinus-Argent Dawn, guild `Rancour-Draenor`, 313 scanned) found three:

```
82.8%  2566/3098  Cryptinus-Argent Dawn
73.8%  2287/3099  Boptinus-Tarren Mill
49.6%  1544/3112  Ictinus-Argent Dawn     ← matches the discord_profile on the applicant
 3.0%    83/2730  Ryii-Silvermoon         ← noise ceiling
```

`Ictinus` corroborates independently: Driptinus's own `characterCustomizations.discord_profile`
is `ictinus`, so the fingerprint rediscovered the account's likely main without being told.

**Match rule:** at least 20% identical of at least 200 common achievements. Across three
samples the observed noise ceiling is 3.0% and the weakest genuine match is 45%, so 20% sits
mid-gap with an order of magnitude of margin either side.

Fingerprints come from
`GET https://{region}.api.blizzard.com/profile/wow/character/{realm}/{name}/achievements`
via the existing client-credentials token in `src/services/blizzard.ts`. Only characters with
timestamps are usable; a character below the achievement threshold or an HTTP error is
skipped, not treated as a non-match.

### Guild expansion

An alt's guild is both useful to reviewers and a fresh candidate pool: alts commonly sit in
different guilds from the main, and a fingerprint sweep of only the applicant's own guild
would miss them.

Discovery is therefore a breadth-first search over guilds:

1. Seed the frontier with the applicant's guild (from their Raider.IO profile, `fields=guild`).
   **A guild's realm is not the character's realm** — `Driptinus-Argent Dawn` is in
   `Rancour-Draenor`, and querying the roster on the character's realm returns
   `Could not find requested guild`. Always take the realm from the `guild` object.
2. Pop a guild, fetch its roster via the existing `getGuildRoster`, and fingerprint each
   member not already fingerprinted, comparing against the applicant only — N comparisons,
   not N².
3. For every confirmed alt (from either source), resolve its guild with
   `GET /api/v1/characters/profile?…&fields=guild` — one cheap documented call each.
4. Push any guild not yet visited onto the frontier.
5. Repeat until the frontier is empty or a cap is hit.

**Rosters are scanned in full.** An early draft capped this at 50 members per guild; tested
against `Goodlife` (429 members) the one genuine alt sat well beyond position 50, so the cap
produced a false negative indistinguishable from "no alts". A truncated roster is worse than
no sweep, because it looks like a result.

Full rosters make concurrency necessary — 417 sequential Blizzard calls took roughly three
minutes. Fingerprint fetches run through a small concurrency limiter (8 in flight); measured
on the Driptinus sweep, 313 characters completed in 15.7 seconds. The repo has no such helper
today, so this is new (small) code.

**Caps**, to bound a sweep that could otherwise walk a large chunk of the region:

| Cap                            | Value |
| ------------------------------ | ----- |
| Guilds visited                 | 5     |
| Total characters fingerprinted | 600   |
| BFS depth                      | 2     |
| Concurrent Blizzard requests   | 8     |

The Blizzard rate limit is 36,000/hour, so even a maxed-out sweep uses under 2% of it.
Characters are deduplicated by `name-realm` across rosters. When a cap truncates the sweep,
the output says so rather than implying completeness.

### Merging and provenance

The two sources are unioned and deduplicated by `name-realm`. Every alt carries its
provenance, since with no declaration question there is nothing to compare against:

- `raider.io` — from the owner's claimed-character list
- `fingerprint (83% match)` — from an achievement match

Where both find the same character, `raider.io` wins, as it is authoritative.

### Output

A second follow-up message after the logs block, grouped by guild. Raider.IO returns every
claimed character including levelling alts — 25 for the tested applicant, 13 of them at ilvl
102 — so the message leads with raid-relevant characters (max level) and collapses the rest to
a count:

```
**Alts** — 25 found for raider.io user "Zenfu"

**Goodlife** *(Tarren Mill)*
**Gorre**-Outland · Death Knight · 291 ilvl — raider.io
**Hitoshura**-Ravencrest · Rogue · 293 ilvl — applicant's main

**No guild**
**Zenfu**-Kazzak · Monk · 291 ilvl — raider.io
**Manhwa**-Ravencrest · Warrior · 245 ilvl — raider.io

*+13 characters below max level (not shown)*
```

Guilds are resolved per shown alt via `fields=guild` — one cheap documented call each, which
also bounds that cost to the max-level subset rather than all 25.

Mythic logs run for the applicant's main plus the **two alts with the most recent raid
activity**, ranked by one `recentReports(limit: 1)` call each. Remaining alts are listed
without a log sweep. This bounds the background job at three sweeps rather than one per alt.

## Integration

`submitApplication` gains a step after the overlord notification that fires the background
job without awaiting it, wrapped so a rejection cannot surface as an unhandled rejection. The
forum post, the database record and the overlord notification all complete exactly as they do
today; the thread simply gains two messages seconds later.

Ordering within the job: logs for the main → alt discovery → logs for the top two alts → alts
message. The logs block posts as soon as it is ready rather than waiting for alt discovery.

## Module layout

| Module                                                          | Responsibility                                                                     |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `src/services/warcraftlogs.ts`                                  | `getApplicantMythicProgress`, zone catalogue fetch + cache                         |
| `src/services/blizzard.ts`                                      | `getCharacterAchievementFingerprint`                                               |
| `src/services/raiderio.ts`                                      | `getCharacterGuild` (documented API)                                               |
| `src/services/raiderioInternal.ts`                              | `getCharacterOwner`, `getClaimedCharacters` (internal endpoints, isolated breaker) |
| `src/utils/concurrency.ts`                                      | Bounded-parallelism helper for fingerprint fetches                                 |
| `src/functions/applications/mythic-logs/selectMythicReports.ts` | Pure: catalogue filter, boss ranking, dedupe, caps                                 |
| `src/functions/applications/mythic-logs/renderMythicLogs.ts`    | Pure: message text                                                                 |
| `src/functions/applications/alts/compareFingerprints.ts`        | Pure: match ratio and threshold                                                    |
| `src/functions/applications/alts/discoverAlts.ts`               | BFS orchestration, caps, merge                                                     |
| `src/functions/applications/alts/renderAlts.ts`                 | Pure: message text                                                                 |
| `src/functions/applications/postApplicantIntel.ts`              | Background job: sequencing and posting                                             |

Selection, ranking and rendering are pure functions taking plain data, matching how
`extractMatchingCodes` is structured and tested today.

## Error handling

Every external call goes through `httpRequest`, inheriting the circuit breaker and
`apiHealth` tracking. Failures degrade rather than propagate:

| Failure                             | Behaviour                                                 |
| ----------------------------------- | --------------------------------------------------------- |
| No Raider.IO URL in answers         | Both features skipped silently                            |
| WCL down or circuit open            | `No Mythic raid logs found` message                       |
| Blizzard down                       | Fingerprint fallback skipped; Raider.IO alts still posted |
| Raider.IO internal endpoints broken | Source 1 skipped; fingerprint fallback runs               |
| Character owner privacy-hidden      | Source 1 yields nothing; fingerprint fallback runs        |
| Applicant guildless and unclaimed   | No alts found; message says so explicitly                 |
| Any unexpected throw                | Logged at warn; application unaffected                    |

An application must never fail, and a thread must never be left half-built, because a
third-party API is unavailable.

## Testing

Unit tests cover the pure functions with fixture data:

- Zone catalogue filtering: `>= 500` rollups, PTR/Beta names, dungeon-only zones, sparse zones
- Boss ranking with wipes: deeper wipe beats shallower kill
- Report dedupe across bosses; the three-per-raid and five-raid caps
- Fingerprint comparison: match, non-match, and insufficient-common-achievements cases
- BFS: guild dedupe, cap enforcement, truncation flag
- Both renderers, including the empty cases

Service functions are tested against a mocked `httpRequest`. No test performs a live API call.
No new environment variables are introduced, so the `ci.yml` stub block is unchanged.

## Known limitations

- **Alt discovery is best-effort.** An applicant with no claimed Raider.IO account, guildless
  alts, and no shared guild membership will not be found. A thin result means "nothing found",
  never "no alts exist".
- **The fingerprint fallback only sees shared guilds.** On the tested applicant it found 1 of
  25 alts, because the other 24 were in different guilds. When source 1 is unavailable, expect
  partial results.
- **Fingerprinting is unavailable for low-achievement characters.** Fresh alts below the
  200-common-achievement floor cannot be matched.
- **The Raider.IO internal endpoints are undocumented** and may change or disappear without
  notice. They are the primary source, so a breakage degrades alt discovery to the much weaker
  fingerprint path — worth knowing when results suddenly thin out.
- **This surfaces characters the applicant did not choose to disclose.** It uses only public
  armory data and requires no consent — the same capability that makes check-pvp.fr
  contentious. This is a deliberate recruitment-vetting decision, not an accident of the
  design.

## Rejected alternatives

| Approach                                    | Why rejected                                                                                                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WCL `User.characters` / `Character.claimed` | Permission denied even for the report owner                                                                                                                   |
| Raider.IO documented API (`/api/v1`)        | No alts field and no owner field; profile returns name/race/class/spec/faction/points only. The internal API is used instead                                  |
| Raider.IO warband endpoint                  | `/api/mythic-plus/rankings/warbands` is a region leaderboard, not a per-character lookup                                                                      |
| Raider.IO `/api/search`                     | Indexes guilds and characters only — no user matches, so a username cannot be searched for                                                                    |
| WoWProgress `json_alts`                     | 403 behind Cloudflare; data is consent-gated by character confirmation                                                                                        |
| check-pvp.fr                                | No documented API, 403 to automated fetch, undocumented mechanism                                                                                             |
| Battle.net OAuth (`/profile/user/wow`)      | Authoritative, but needs a public HTTP callback, redirect URI registration and token lifecycle — a web surface this bot does not have. Viable future upgrade. |
| `zoneRankings` instead of `fights`          | Ranked kills only; cannot see wipes                                                                                                                           |
| Asking the applicant to declare alts        | Explicitly declined — no new application questions                                                                                                            |

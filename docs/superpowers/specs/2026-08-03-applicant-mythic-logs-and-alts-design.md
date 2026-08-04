# Applicant Mythic Logs and Alt Discovery

**Date:** 2026-08-03
**Status:** Design

## Summary

When an application is submitted, the bot posts two follow-up messages to the application
forum thread:

1. **Mythic raid logs** for the applicant's character — the deepest Mythic bosses reached in
   each of up to five recent raid tiers, wipes included, one report link per boss.
2. **Alts** — other characters on the same Battle.net account, discovered without asking the
   applicant, each with its guild. The four most raid-active are swept for logs too, and their
   results are merged into the logs message with each line attributed to its character.

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

**Every character named in the application is collected, not just the first.** The existing
helper returns the first Raider.IO URL it finds; the new one scans all answers and returns all
distinct character URLs. Applicants routinely mention a second character ("I can also play my
alt <link>"), and those characters:

- are always swept for logs, exempt from the sweep caps and the selection heuristics
- are labelled `from the application` in the found-characters message
- count for kills even when those kills post-date the account's first kill (see above)

The first URL remains the applicant's primary character for the thread title and identity.

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

4. **Kill dates from Raider.IO.** `GET /api/characters/{region}/{realm}/{name}/raid-progress?tier={n}`
   returns `encountersDefeated.mythic[]` per raid, each entry carrying `slug`,
   **`firstDefeated`**, `lastDefeated`, `numKills` and the guild it was killed with. The `tier`
   parameter is a numeric ordinal and reaches back through the window — `34` returns Manaforge
   Omega, `33` Liberation of Undermine, `30` Aberrus. One call per character per tier, no WCL
   points.

   **Raider.IO supplies dates; WCL remains the authority on what was killed.** The same
   `Brenthunter` payload lists 7 Mythic kills but omits Crown of the Cosmos, which WCL shows him
   killing — the character was last crawled 2026-05-15 and the kill post-dates that. Treating
   the absence of an `encountersDefeated` entry as "not killed" would report a killed boss as
   wipe progress.

   So the field is used as a fast path and for display, never as a gate: where Raider.IO names a
   date, jump straight to that report; where it says nothing, still scan WCL. On disagreement,
   WCL wins.

5. **Fights pass, targeted.** For a boss with a kill, fetch fights only for the reports on the
   first-kill date to locate and confirm the report. For a boss with no kill anywhere, scan the
   tier's reports newest-first until wipes on that boss are found. Filter to `encounterID`s in
   the zone catalogue — raid reports also contain Mythic+ fights and trash fights with
   `difficulty: null`.

6. **Selection.** Within a tier, rank bosses by depth descending. Walk the ranking taking one
   report per boss, skipping any report already linked for a deeper boss, and stop at three
   links. A single report covering bosses 6–8 therefore produces one link, not three.

### Which report is shown for a boss

- **Killed:** the **first** kill — the earliest report in which the boss died, not the most
  recent. A reviewer wants to know when the account first got the boss down, since that is what
  dates their progression.
- **Not killed:** the **most recent** report containing wipes on that boss, which is the best
  evidence of current progress.

**First kill is account-level, not per character.** If the account killed a boss on one
character and later killed it again on an alt, only the earliest kill counts — a re-kill on an
alt months later is not progression and must not be presented as such.

**Exception: characters named in the application always count.** Kills by any character the
applicant listed are shown even when they post-date the account's first kill, because a
reviewer explicitly wants to know what the named characters themselves have done. So the
candidate set per boss is the account's earliest kill, plus any kill by an
application-named character.

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
6/8 **Fractillus** — first kill 2025-10-19 · [report](https://www.warcraftlogs.com/reports/ZDHVbJdK2yx9nkhf)

**Liberation of Undermine** *(The War Within)*
6/8 **One-Armed Bandit** — wiping, best 0.7% · [report](https://www.warcraftlogs.com/reports/v4wVWRhfYyrnCpFT)
4/8 **Rik Reverb** — first kill 2025-03-11 · [report](https://www.warcraftlogs.com/reports/vWrJFmNHxtQw9pZ8)
```

With no Mythic history, the message is explicit rather than absent:
`No Mythic raid logs found for **X** in the last 3 expansions.` Silence would be ambiguous to
a reviewer.

### Attribution across characters

The message merges results from the applicant's character _and_ their swept alts, so **every
line names the character the report belongs to**. Without it a reviewer cannot tell whose
progression they are reading:

```
**Mythic raid logs** — Brentpriest + 4 alts

**VS / DR / MQD** *(Midnight)*
9/9 **Midnight Falls** — wiping, best 80.5% · **Brenthunter** · [report](https://www.warcraftlogs.com/reports/1rkzLm8jK9x3YCwc)
8/9 **Belo'ren, Child of Al'ar** — first kill 2026-05-03 · **Brenthunter** · [report](https://www.warcraftlogs.com/reports/HMhq7rgJ9YdGBWRb)
7/9 **Chimaerus, the Undreamt God** — first kill 2026-04-09 · **Brenthunter** · [report](https://www.warcraftlogs.com/reports/N7tJvzVBZF2YXQ3d)

**Manaforge Omega** *(The War Within)*
8/8 **Dimensius, the All-Devouring** — first kill 2025-10-30 · **Brenthunter** · [report](https://www.warcraftlogs.com/reports/RQ8CZKMAFWGdtq9n)
```

Killed bosses show the first-kill date, which dates the account's progression; wipe-only bosses
show the best percentage instead, since there is no kill to date.

That applicant applied on `Brentpriest`, which reaches 4/8 on its own, while the account is
9/9-progressing on `Brenthunter`. Both facts matter and neither is legible without the label.

**Merge rule.** Tiers are pooled across characters; within a tier each boss resolves to one
entry:

1. If any character killed it — the **earliest** kill across the account (see First kill above)
2. Otherwise — the most recent report with wipes, choosing the lowest boss percentage seen
3. Ties break to the applicant's named characters, then to the earlier report

Rule 3's first clause exists because of an observed regression: `Brentdh` also killed
Rasha'nan at 4/8, so a plain recency tie-break removed `Brentpriest` — the character the
application was actually made on — from its own message.

The three-links-per-tier and five-tier caps then apply to the pooled result, so an alt's
genuinely deeper progression can still displace the applicant's line rather than being
appended to it.

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

#### Declared main (`main_character`)

The same payload may carry `characterCustomizations.main_character`, a full character object
naming the main this character is an alt of — the "(Alt of X)" shown on the site. It is
player-declared, free (already in the payload we fetch), and survives when `user` is hidden.

```
Yawnersw-Silvermoon (Monk) → main_character: Yawnersowo-Draenor (Druid)
```

When present:

1. Record the main and show it in the output as a declared link.
2. **Pivot to it** — retry the owner lookup against the main, and seed the fingerprint frontier
   with the main's guild rather than the alt's. A main is likelier to be claimed, better
   guilded, and more raid-relevant than the alt someone applied on.

An absent `main_character` on a character that has one elsewhere means nothing; only its
presence is informative. On the tested pair the fingerprint reached the same main (54%) but
needed 313 requests and a shared guild to do it, where the declared link needed neither.

These are undocumented internal endpoints with no stability guarantee. They must fail soft
and must never prevent source 2 from running. They get their own `apiHealth` service key
(`raiderio-internal`) so a breakage cannot open the circuit for the documented Raider.IO API
that `getGuildRoster` and the achievements image depend on.

### Source 2 — Blizzard achievement fingerprint

Finds alts that are not claimed on Raider.IO, and is the only source that works when the owner
is privacy-hidden — which was the case for four of the five characters tested. It runs
alongside source 1 rather than only as a fallback, seeded from every guild source 1 reveals
(see Guild expansion below).

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

A fourth sample (Yawnersw-Silvermoon, same `Rancour-Draenor` roster) found nine, with the
weakest genuine match of any sample:

```
56.7%  Yawnersx-Draenor
54.x%  Yawnersowo-Draenor      ← the declared main, found independently
31.0%  Yawners-Draenor         ← weakest true match observed
```

**Match rule:** at least 20% identical of at least 200 common achievements. Across four
samples the observed noise ceiling is 3.0% and the weakest genuine match is 31%. An earlier
draft used 30%, which `Yawners-Draenor` would have cleared by one point — 20% keeps a real
margin below the weakest observed alt while staying an order of magnitude above the noise.

Fingerprints come from
`GET https://{region}.api.blizzard.com/profile/wow/character/{realm}/{name}/achievements`
via the existing client-credentials token in `src/services/blizzard.ts`. Only characters with
timestamps are usable; a character below the achievement threshold or an HTTP error is
skipped, not treated as a non-match.

### Guild expansion

An alt's guild is both useful to reviewers and a fresh candidate pool: alts commonly sit in
different guilds from the main, and a fingerprint sweep of only the applicant's own guild
would miss them.

Discovery is therefore a breadth-first search over **every guild associated with the account**,
not just the applicant's own. Scanning only the linked character's guild finds only the alts
that happen to share it — for Hitoshura that was 1 of 25.

1. **Seed with every known character's guild.** Resolve the guild of the applicant's
   character, the declared main, and every character returned by source 1, each via
   `GET /api/v1/characters/profile?…&fields=guild` — one cheap documented call per character.
   Deduplicate guilds by `name-realm`.

   **A guild's realm is not the character's realm** — `Driptinus-Argent Dawn` is in
   `Rancour-Draenor`, and querying the roster on the character's realm returns
   `Could not find requested guild`. Always take the realm from the `guild` object.

2. Pop a guild, fetch its roster via the existing `getGuildRoster`, and fingerprint each
   member not already fingerprinted, comparing against the applicant only — N comparisons,
   not N². Characters already known from source 1 are recorded as alts without being
   fingerprinted.

3. For every newly confirmed alt, resolve its guild the same way.

4. Push any guild not yet visited onto the frontier.

5. Repeat until the frontier is empty or a cap is hit.

Source 1 and source 2 therefore compose rather than compete: a claimed-character list of 25
seeds up to 25 guilds, and the fingerprint then finds the _unclaimed_ alts sitting in any of
them. Because of this, source 2 now runs whenever any guild is known, not only when source 1
comes back empty.

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
| Guilds visited                 | 12    |
| Total characters fingerprinted | 3,000 |
| BFS depth                      | 3     |
| Concurrent Blizzard requests   | 8     |

Seeding from every associated guild raises the ceiling considerably: 12 guilds the size of
`Rancour` (315 members) is ~3,800 characters before deduplication. At the measured rate
(313 in 12s) a maxed-out sweep is roughly two minutes of background work and 3,000 of the
36,000 hourly Blizzard requests — under 10%, but no longer negligible, which is what makes
the scheduling below necessary rather than optional.

Characters are deduplicated by `name-realm` across rosters, so overlapping rosters cost
nothing the second time. When a cap truncates the sweep, the output says so rather than
implying completeness.

### Merging and provenance

The sources are unioned and deduplicated by `name-realm`. Internally each finding keeps the
source that produced it, but the message does **not** expose the mechanism — a reviewer only
needs to know whether the applicant told us about a character or not:

| Internal source                  | Displayed as                   | Confidence |
| -------------------------------- | ------------------------------ | ---------- |
| The character in the application | `from the application`         | —          |
| Raider.IO claimed-character list | `undeclared (100% confidence)` | 100%       |
| `main_character` declared main   | `undeclared (100% confidence)` | 100%       |
| Achievement fingerprint          | `undeclared (N% confidence)`   | match %    |

Raider.IO-sourced characters are account-authoritative, so they take 100% rather than a
computed score. This keeps a single sort key across all sources.

"% match" is called **% confidence** in the output.

### Output

A message listing every character found, sorted **application character first, then undeclared
by descending confidence**. Flat, not grouped by guild — guild is shown inline so the ordering
can be by confidence. Each character name links to its Raider.IO profile:

```
**Found characters** — 16

[Regnipaw-Draenor](https://raider.io/characters/eu/draenor/Regnipaw) · Druid · Rancour (Draenor) — from the application
[Monkni-Draenor](https://raider.io/characters/eu/draenor/Monkni) · Monk · Rancour (Draenor) — undeclared (93% confidence)
[Regnigrip-Draenor](https://raider.io/characters/eu/draenor/Regnigrip) · Death Knight · Rancour (Draenor) — undeclared (91% confidence)
[Rainster-Ravencrest](https://raider.io/characters/eu/ravencrest/Rainster) · Warrior · Rancour (Draenor) — undeclared (88% confidence)
…
```

Item level is not shown. An earlier draft displayed it and filtered on it, which was wrong on
both counts: the threshold was arbitrary, and `Monkni-Draenor` came back at 481 ilvl against
its siblings' ~290 (a different content type), so the number misleads more than it informs.

**No characters are filtered out.** Every character found is listed. Guild is resolved for
each via `fields=guild` — one cheap documented call per character.

### Links

Character names link to `https://raider.io/characters/{region}/{realm-slug}/{Name}` — realm
lowercased with spaces replaced by hyphens (`Tarren Mill` → `tarren-mill`); name casing is
irrelevant, both forms return 200.

Two things to know about how these render:

- **Raider.IO serves no per-character OpenGraph data.** Its character pages are
  client-rendered and expose only static site-wide tags (`og:url` is literally
  `https://raider.io`). Discord can never produce a meaningful preview for them, so link
  previews are a non-issue for this message. Warcraft Logs report links _do_ have real OG data,
  which is why those stay masked.
- **Masked links must go in an embed.** `[text](url)` is reliably parsed in an embed
  description; in plain message content it is not, and renders literally as
  `[report](https://…)`. Both intel messages are therefore embeds — this is a hard requirement
  of the format, not a stylistic choice, and posting either as plain content will visibly break
  every link.
- **URLs must be absolute.** Only a full `https://…` target linkifies. Any elided or
  relative-looking form (`.../reports/abc123`) renders as literal text.

### Message size and paging

The list is rendered as an **embed**, not plain content: an embed description allows 4,096
characters against a message's 2,000. At ~110 characters per line that is ~37 characters
listed in a single message, so every account tested — including the 25-character one — fits
without paging. `splitMessage` is deliberately not used here; it would spread the list across
several messages and push the voting controls further down the thread.

Beyond that, the message pages. The repo already has `paginateLines`, `buildPageEmbed` and
`buildPageButtons` in `src/functions/pagination.ts`, and they are reused as-is — but **not**
the accompanying cache. `src/interactions/pagination.ts` resolves pages from an in-memory
store with a 5-minute TTL and tells the user to "run the command again" when it lapses. That
is correct for `/raiders` and `/trials`, and wrong for a forum post a reviewer opens days
later, where there is no command to re-run.

Instead, a durable handler with custom ID `intelpage:{applicationId}:{page}` rebuilds the
requested page from `applicant_intel_findings` on demand. Pages are therefore valid for as
long as the job row exists, and survive a bot restart. The existing cache-based `page:` handler
is left untouched.

### Which characters get a log sweep

Mythic logs run for the applicant's character (always) plus **four alts**, chosen in two
stages rather than guessed.

**Stage 1 — Raider.IO tells us who has Mythic kills.** `fields=raid_progression` returns
`mythic_bosses_killed` per raid for one cheap documented call per character, no WCL points
spent. Characters with any Mythic kill go to the front of the queue, ranked by kill count. On
`Brentpriest-Draenor`'s 19 claimed characters this flagged exactly `Brenthunter` (7/9 M) and
`Brentprietwo` (6/9 M) — the same two a WCL probe picks, for free.

**Stage 2 — WCL fills the remaining slots by tier coverage, not recency.** Probe each unchosen
character with `recentReports(limit: 20)` filtered to raid zones. That probe returns the set of
tiers the character has raided, so fill the slots greedily: each pick is the character adding
the most tiers not already covered by the characters chosen so far.

Recency is the wrong key. On `Brentpriest` it selected `Brentwartwo` and `Brentmagetwo`, whose
only tier was VS / DR / MQD — already covered by `Brenthunter`. Two sweeps, nothing learned,
and the result stalled at three tiers. Greedy coverage picked `Brentdh` instead and surfaced a
fourth tier, Aberrus, with Dragonflight wipe progression that recency never reached.

Stage 2 is required because `raid_progression` has three blind spots, all observed:

- **Current expansion only.** Regnipaw's `raid_progression` lists four Midnight raids; his
  Amirdrassil 9/9 and Nerub'ar Palace kills do not appear. `Brentpriest` reads zero Mythic
  kills while WCL shows a Nerub'ar Rasha'nan kill.
- **Crawl lag.** `Brenthunter` was last crawled 11 weeks before this was written. Regnipaw
  reports `4/9 M` where WCL already has a Midnight Falls kill.
- **Kills only.** Wipe-only progression is invisible to it, and wipes are explicitly in scope
  for this feature.

Treating it as a gate would therefore hide exactly the history the three-expansion window
exists to surface. As a prioritiser it costs nothing and improves the ordering.

Four alts rather than two because of players who rotate characters per raid: `Brentpriest` has
19 claimed characters, and sweeping five produced only three tiers with the applicant's own
character contributing one. Five sweeps is roughly 1,500 WCL points against 9,000/hour.

## Resumable jobs and rate-limit handling

A sweep can now issue thousands of requests across three APIs, so it must survive hitting a
rate limit — and a bot restart — without losing what it has already found. The work is
therefore a **persisted job**, not an in-memory background promise.

### Schema (migration v11)

Four tables, normalised so progress is recorded incrementally rather than by rewriting a large
JSON blob on every step:

```sql
applicant_intel_jobs (
  id INTEGER PRIMARY KEY,
  application_id INTEGER NOT NULL,
  thread_id TEXT,
  character_name TEXT NOT NULL,
  character_realm TEXT NOT NULL,
  character_region TEXT NOT NULL,
  phase TEXT NOT NULL,          -- 'logs' | 'alt_sources' | 'fingerprint' | 'alt_logs' | 'done'
  status TEXT NOT NULL,         -- 'pending' | 'running' | 'paused' | 'done' | 'failed'
  resume_after TEXT,            -- ISO timestamp; NULL when not paused
  paused_service TEXT,          -- which API caused the pause
  attempts INTEGER NOT NULL DEFAULT 0,
  logs_message_id TEXT,
  alts_message_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)

applicant_intel_queue (
  job_id INTEGER NOT NULL,
  kind TEXT NOT NULL,           -- 'guild' | 'report' | 'character_guild'
  key TEXT NOT NULL,            -- 'Rancour-draenor', a WCL report code, …
  payload TEXT,                 -- JSON: zone id, BFS depth, …
  done INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (job_id, kind, key)
)

applicant_intel_scanned (
  job_id INTEGER NOT NULL,
  character_key TEXT NOT NULL,  -- 'name-realm', lowercased
  PRIMARY KEY (job_id, character_key)
)

applicant_intel_findings (
  job_id INTEGER NOT NULL,
  name TEXT NOT NULL, realm TEXT NOT NULL,
  class TEXT, item_level INTEGER,
  guild_name TEXT, guild_realm TEXT,
  source TEXT NOT NULL,         -- 'raider.io' | 'declared main' | 'fingerprint'
  match_pct REAL,
  PRIMARY KEY (job_id, name, realm)
)
```

`applicant_intel_scanned` is what makes the fingerprint resumable: 3,000 rows of
`name-realm` is cheap to insert incrementally and to check on resume, where a JSON array
rewritten per character would not be.

### Detecting a limit

`httpRequest` already retries 429s and honours `Retry-After` up to 30 seconds, then throws
`HttpError` with `status`. That covers a brief throttle. What it cannot cover is an exhausted
hourly budget, where the correct wait is minutes.

Two changes:

1. **Surface the wait.** Add an optional `retryAfterMs` to `HttpError`, populated from the
   final response's `Retry-After`. Without it the runner can only guess.
2. **Pre-empt WCL's points budget.** WCL bills by points, not requests, and returns
   `rateLimitData { limitPerHour, pointsSpentThisHour }` on any query for ~1 point. The runner
   requests it on each `fights` query it already makes and pauses when spend exceeds 90% of
   the limit, rather than waiting to be refused.

A pause is triggered by an `HttpError` with status 429, a `CircuitOpenError`, or the WCL
points pre-empt. Any other error fails only the current work item, which is marked done so a
resume does not retry it forever.

### Pausing and resuming

On pause the runner writes `status='paused'`, the offending service, and `resume_after`:
`Retry-After` when known, otherwise a backoff of 5min → 15min → 60min by attempt count, capped
at one hour (the natural window for both the Blizzard and WCL budgets). Everything completed
so far is already in the tables, so nothing is lost.

A scheduler interval task (`resumeApplicantIntelJobs`, every 5 minutes) picks up jobs where
`status='paused' AND resume_after <= now` and continues them from their recorded phase and
queue. On startup, jobs left `running` by a crash are reset to `pending` and picked up on the
next tick — the same crash-recovery shape as `resumeSessions`.

Jobs are abandoned after 20 attempts or 7 days, whichever comes first: `status='failed'`, with
a note appended to the thread message so a reviewer knows the picture is incomplete rather
than empty.

### Partial results are published, not withheld

Because the placeholders already exist (see Thread layout under Integration), a paused job can
show its progress rather than sitting blank. On pause the runner edits its messages with whatever it has and a footer:

```
*Rate limited on blizzard — 1,240 of ~3,000 characters scanned. Resuming after 14:05.*
```

On resume it edits the same messages again, and the footer is removed when the job completes.
A reviewer looking at a thread mid-sweep sees real findings and an honest statement of what is
still missing, never a silently truncated list that looks complete.

Nothing found is ever lost to a pause: every scanned character, queue item and finding is
committed to the tables as it happens, so a pause costs time, not work.

## Integration

`submitApplication` gains a step after the overlord notification that inserts an
`applicant_intel_jobs` row and kicks the runner without awaiting it, wrapped so a rejection
cannot surface as an unhandled rejection. The forum post, the database record and the overlord
notification all complete exactly as they do today; the thread gains its messages seconds
later, or minutes later if the runner has to wait out a rate limit.

Because the job row is written before any API call, a crash between submission and the first
request loses nothing — the scheduler picks it up as `pending`.

### Thread layout

The required reading order is Q&A → found characters → found logs → voting. Discord cannot
insert a message between existing ones, and the intel takes seconds to minutes, so
`createForumPost` posts two **placeholders** in position at creation time and the job edits
them in place:

| #   | Message                             | Posted by         |
| --- | ----------------------------------- | ----------------- |
| 1   | Q&A (split as today)                | `createForumPost` |
| 2   | `**Found characters** — searching…` | `createForumPost` |
| 3   | `**Mythic raid logs** — fetching…`  | `createForumPost` |
| 4   | Voting embed                        | `createForumPost` |
| 5   | Accept / Reject buttons             | `createForumPost` |

Their ids are written to `alts_message_id` and `logs_message_id` on the job, which the runner
already needed for resume-and-edit.

A placeholder must never be left reading "searching…" forever. Every terminal state edits
them: success writes the results, an empty result writes the explicit "none found" text, and
failure or abandonment writes what was gathered plus why it stopped.

Report links use markdown (`[report](url)`) rather than bare URLs: a tier with three links
would otherwise produce three Discord link previews and swamp the thread. Both messages are
embeds — see Message size and paging for why, and for the durable page handler the
found-characters list needs.

Phases run in the order recorded on the job, each resumable independently:

1. `logs` — Mythic logs for the applicant's character; edits the logs placeholder when ready
2. `alt_sources` — declared main, owner lookup, claimed characters, guild resolution
3. `fingerprint` — BFS over every associated guild
4. `alt_logs` — Mythic logs for the four most raid-active alts, merged into the logs message
5. `done` — final edit of both placeholders, footer removed

Each phase edits the relevant placeholder as its results firm up, so the thread fills in
progressively rather than all at once at the end.

## Module layout

| Module                                                          | Responsibility                                                                                           |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `src/services/warcraftlogs.ts`                                  | `getApplicantMythicProgress`, zone catalogue fetch + cache                                               |
| `src/services/blizzard.ts`                                      | `getCharacterAchievementFingerprint`                                                                     |
| `src/services/raiderio.ts`                                      | `getCharacterGuild`, `getRaidProgression` (documented API)                                               |
| `src/services/raiderioInternal.ts`                              | `getCharacterOwner`, `getClaimedCharacters`, `getMythicKillDates` (internal endpoints, isolated breaker) |
| `src/utils/concurrency.ts`                                      | Bounded-parallelism helper for fingerprint fetches                                                       |
| `src/functions/applications/mythic-logs/selectMythicReports.ts` | Pure: catalogue filter, boss ranking, dedupe, caps                                                       |
| `src/functions/applications/mythic-logs/renderMythicLogs.ts`    | Pure: message text                                                                                       |
| `src/functions/applications/alts/compareFingerprints.ts`        | Pure: match ratio and threshold                                                                          |
| `src/functions/applications/alts/discoverAlts.ts`               | BFS orchestration, caps, merge                                                                           |
| `src/functions/applications/alts/renderAlts.ts`                 | Pure: message text                                                                                       |
| `src/functions/applications/intel/jobStore.ts`                  | Job/queue/scanned/findings table access                                                                  |
| `src/functions/applications/intel/runJob.ts`                    | Phase sequencing, pause/resume, message editing                                                          |
| `src/functions/applications/intel/rateLimit.ts`                 | Pure: classify an error as pausable, compute `resume_after`                                              |
| `src/functions/applications/intel/resumeJobs.ts`                | Scheduler task: pick up paused/pending jobs, crash recovery                                              |
| `src/interactions/intelPagination.ts`                           | Durable `intelpage:` handler rebuilding pages from `applicant_intel_findings`                            |

Selection, ranking and rendering are pure functions taking plain data, matching how
`extractMatchingCodes` is structured and tested today.

## Error handling

Every external call goes through `httpRequest`, inheriting the circuit breaker and
`apiHealth` tracking. Failures degrade rather than propagate:

| Failure                                      | Behaviour                                                       |
| -------------------------------------------- | --------------------------------------------------------------- |
| No Raider.IO URL in answers                  | No job created; both features skipped silently                  |
| Rate limit (429 / WCL points / open circuit) | Job pauses, partial results posted, resumes automatically       |
| WCL down or circuit open                     | `No Mythic raid logs found` message                             |
| Blizzard down                                | Fingerprint phase skipped; Raider.IO alts still posted          |
| Raider.IO internal endpoints broken          | Sources 1 and the declared main skipped; fingerprint still runs |
| Character owner privacy-hidden               | Source 1 yields nothing; other sources still run                |
| Applicant guildless and unclaimed            | No alts found; message says so explicitly                       |
| Bot restart mid-sweep                        | Job resumes from its recorded phase and queue                   |
| 20 attempts or 7 days elapsed                | Job marked `failed`; thread message notes it is incomplete      |
| Any unexpected throw                         | Logged at warn; application unaffected                          |

An application must never fail, and a thread must never be left half-built, because a
third-party API is unavailable.

## Testing

Unit tests cover the pure functions with fixture data:

- Zone catalogue filtering: `>= 500` rollups, PTR/Beta names, dungeon-only zones, sparse zones
- Boss ranking with wipes: deeper wipe beats shallower kill
- Report dedupe across bosses; the three-per-raid and five-raid caps
- Cross-character merge: earliest kill wins over a later re-kill on an alt; a wipe-only boss
  takes the most recent wipe report; each surviving line keeps the right attribution
- Application-named characters: all URLs in the answers are collected, all are swept, and
  their kills survive the account-first-kill rule
- Kill-date mapping: a `firstDefeated` timestamp resolves to the right report, and a boss with
  no `encountersDefeated` entry falls through to the wipe path
- Sweep selection: Mythic-kill characters ordered first, greedy tier coverage filling the
  remainder, the applicant's character always included even at zero reported kills
- Greedy coverage: a candidate whose tiers are already covered is not chosen over one that
  adds a new tier, regardless of recency
- Fingerprint comparison: match, non-match, and insufficient-common-achievements cases
- BFS: multi-guild seeding, guild dedupe, cap enforcement, truncation flag
- Rate-limit classification: 429 with and without `Retry-After`, `CircuitOpenError`, WCL
  points pre-empt, and non-pausable errors that must not pause the job
- Backoff schedule, including the attempt cap and the 7-day abandonment
- Resume: a job with a half-finished queue continues without redoing `scanned` characters
- Both renderers, including the empty cases and the rate-limited footer

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

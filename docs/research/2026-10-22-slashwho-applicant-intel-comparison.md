# SlashWho as the applicant-intel engine

**Date:** 2026-10-22
**Issue:** #121
**Status:** Investigation complete for the deployed contract and three real applicants. Recommendation below; decision pending.
**SlashWho revision examined:** `main` at [`d25fd281`](https://github.com/Erilla/SlashWho/tree/d25fd281fcb4bbc761c58d0a1bbec817340b4078) (2026-10-13), plus the deployed API at `https://slashwho.com`.

## Question

Can SlashWho replace the bot's applicant-intel sweep — alt discovery, guild history, and Mythic
logs — in whole or in part, so the bot stops running its own multi-provider research pipeline?

## Method

**SlashWho side.** Probed the deployed API anonymously (no `BOT_API_KEY` was available locally), read
the contracts and services at the revision above, and pulled the dossier payload for each sample.
`POST /api/dossiers` with a fresh character returned `200 {"kind":"ready"}`, so the start and read
contracts were exercised without spending collection work.

**Bot side.** Ran the real intel pipeline for the same characters with the production wiring from
`resumeApplicantJobs` (`src/functions/applications/intel/resumeJobs.ts:108`), a temporary SQLite
database, and a captured `editMessage`. Each run therefore executed the real `discoverAlts`,
`confirmDiscord`, `gatherMythicLogs`, guild-history aggregation, and renderers. Warcraft Logs points
were read from `rateLimitData` before and after each run.

**Samples.** Three characters from SlashWho's live recent searches, i.e. real applicants from the
Google Sheet intake rather than synthetic data:

| Root | SlashWho dossier | Why |
|---|---|---|
| `eu/argent-dawn/ragedoom` | 2 characters, 3 guilds, 4 CE | Small, recent, cheap |
| `eu/kazzak/raasta` | 8 characters, 7 guilds, 10 CE | The fullest component in recent searches |
| `eu/kazzak/raashe` | 3 characters, 7 guilds, 10 CE | Same person as `raasta`, but a root SlashWho discovered less from |

**Important scope note.** SlashWho's own application linking is driven by a Google Sheet watcher
(`docs/operations/applicant-sheet-watcher.md`). The bot's `/apply` flow is a Discord DM questionnaire,
so none of these dossiers were assembled from a bot application. An integration would have to drive
SlashWho itself for `/apply` applicants (see [Integration mechanics](#integration-mechanics)).

## The deployed contract

| Call | Observed / documented |
|---|---|
| `POST /api/dossiers` `{ "characterUrl": "https://raider.io/characters/eu/kazzak/raasta" }` | `200 {"kind":"ready"}` when a fresh snapshot exists; `202 {"kind":"job","jobId","status"}` plus `Location` when collection was queued |
| `GET /api/dossiers/jobs/{jobId}` | `{ status, error }`, statuses `queued \| running \| retrying \| complete \| failed` |
| `GET /api/dossiers/{region}/{realm}/{name}` | Full `ApplicantDossier`; a non-canonical spelling `308` redirects (observed); `404 discovery_not_ready` before the first snapshot, from the route at `[name]/route.ts:61` |
| `GET /api/dossiers/evidence-runs?ids=…` | Per-character run states and phase progress, no provider calls |
| `POST /api/dossiers/{region}/{realm}/{name}/connected-characters` | Links another character to a dossier; triggers a search for it; returns `ready` or a job |
| `PATCH` / `DELETE` on the same path | Exclude / remove a connected character |

- **Auth.** `Authorization: Bearer <BOT_API_KEY>` classifies the caller as `bot`
  (`packages/application/src/auth.ts:33`). Without it, the caller is bucketed per trusted client IP.
  Reads worked anonymously from a normal client.
- **Quotas.** `BOT_SEARCHES_PER_HOUR=60`, `PUBLIC_READS_PER_MINUTE=300`,
  `ANONYMOUS_SEARCHES_PER_HOUR=10`, `TIER_SEARCHES_PER_HOUR=6`, `FRESHNESS_HOURS=24`. Connection
  mutations use their own bucket with the same 60/hour bot limit as searches.
- **Freshness.** Snapshots are immutable. A read inside 24 hours serves the stored snapshot; the
  `POST` then answers `ready` and queues no work. A `PATCH`/`POST` connection is the only way to
  change a dossier's membership inside that window.
- **Research state.** `research.state` is one of `initial`, `provisional`, `gathering`, `complete`,
  `partial`. `gathering` on a read means collection is in flight (`evidenceRunIds` says which runs);
  `partial` means it settled with declared `limitations`. One of the samples moved
  `gathering → partial` between reads 20 minutes apart.
- **`/api/v1` is not deployed.** `tests/fixtures/contracts/bot-client-v1.json` describes
  `/api/v1/searches` and `/api/v1/characters/...`; those paths `404` on `slashwho.com` and do not
  exist on `main`. The live surface is `/api/dossiers`.
- **Payload size.** 183 KB–1.8 MB of JSON per dossier for the samples (29 raid tiers, every boss,
  every first kill, roster, parse row, and wipe). There is no field projection, and every response is
  `Cache-Control: no-store`, so each poll re-reads the whole document.

## What SlashWho knows that the bot does not

For the `raasta` dossier: 74 Mythic kills over 29 tiers, 39 with a historic world rank, 31 with a
kill roster, 74 first-kill parse rows, 89 best-parse rows, 71 guild raid nights, and 10 Cutting Edge
achievements. The bot renders per-tier boss depth, first-kill dates, best wipe percentage, and one
report link per boss. SlashWho additionally carries:

- **Cutting Edge as a Blizzard achievement**, with the completion timestamp. The bot infers CE from
  Raider.IO kill dates against a tier end (`determineCE` in `gatherMythicLogs.ts:185`) and can miss
  it: for `ragedoom` the bot's guild-history message showed no CE at all, while SlashWho held four
  CE achievements for the same two characters, including `Cutting Edge: Midnight Falls` on
  2026-08-03 — the same boss the bot reported as a 0.7% wipe. CE is account-wide, so the achievement
  proves the account has it even when the earning character was never discovered.
- **Kill rosters and world ranks** per first kill.
- **First-kill and best parses**, which the bot does not show at all.
- **Guild raid nights**, i.e. the dates a guild actually raided, not just kill dates.
- **Per-character limitations** with a machine-readable code and `affects` / `recovery` fields, so
  "we could not read this" is distinguishable from "there is none". The bot has partial equivalents
  in the rate-limit footer and the truncation note, but not per character.

## Measured comparison

| | `ragedoom` | `raasta` | `raashe` |
|---|---|---|---|
| Bot characters | 2 | 8 | **1** |
| SlashWho characters | 2 | 8 | **3** |
| In both / bot only / SlashWho only | 2 / 0 / 0 | 8 / 0 / 0 | 1 / 0 / 2 |
| Bot wall clock | 49 s | 94 s | 31 s |
| Bot characters compared (Blizzard) | 1,820 | 1,901 | 836 |
| Bot WCL points | 264.1 | 547.7 | 108.6 |
| Bot guilds | 5 | 4 | 1 |
| SlashWho guilds | 3 | 7 | 7 |
| Bot raid tiers rendered | 5 | 5 | 5 |
| SlashWho raid tiers | 29 | 29 | 29 |
| Bot CE verdicts | 0 | 2 (Bad Alts) | 2 (Bad Alts) |
| SlashWho CE achievements | 4 | 10 | 10 |

### Discovery matches at a good root, and depends on the root on both sides

- `raasta`: both sides found the same **8 of 8** characters, across two realms, with the same
  classes and guilds. `ragedoom`: both found the same **2 of 2**.
- The bot's fingerprint confidences for the eight (48%, 78%, 79%, 80%, 81%, 84%, 100%) show how
  close several matches sat to the threshold; SlashWho reports only `fingerprint_derived`, so a
  reviewer loses the ability to judge a weak match.

### The unguilded case is a bot blind spot

Starting from `raashe` — the same person as `raasta`, but currently unguilded — the bot found **1**
character and SlashWho found **3** (`raashe`, `raathe`, `kebai`). The mechanism is worth recording
because it is structural, not a one-off:

- `getCharacterOwner(raashe)` returns `user: null` and `declaredMain: null`, so there is no
  claimed-character list and no declared main to follow.
- `raashe` has no current guild, so there is no roster to seed the sweep from. Its only guild seed
  is `Bad Alts` (Silvermoon) from its former kill history. The bot swept that roster (836 characters,
  575 fingerprint cache rows) and matched nothing.
- Starting from `raasta`, the bot follows `raasta`'s owner declaration (main = `Raashe`) and sweeps
  `Spilled Coffee`, which is how it reaches the rest of the account.

So the bot's recall depends heavily on the seed being guilded and having a Raider.IO owner
declaration. A returning player who has left their guild is the worst case, and it is exactly the
applicant an officer knows least about. SlashWho from the same root found two more characters, but it
is also root-dependent (`3` from `raashe` versus `8` from `raasta`).

**This is fixable by seeding, not by choosing a provider.** The bot knows every character the
applicant named. Creating one dossier and linking each other declared character with
`POST .../connected-characters` makes the root choice irrelevant and should reproduce the `8 of 8`
result from `raashe` too.

### Neither side sees the whole guild history

`raasta` is the clearest case:

- The bot renders **4** guilds: Bad Alts, Spilled Coffee, Profanities, Tavern.
- SlashWho holds **7**: Hidden Potential (2018), Mana Curve (2018), Tiras Valesh, Edition, Tavern,
  Profanities, Bad Alts — four of them older than the bot's window — and it omits **Spilled Coffee**,
  whose single Mythic kill Raider.IO recorded but SlashWho's report scan did not surface (possibly its
  own `history_limit` cut).
- The cause is structural. The bot reads Raider.IO kill dates for the last **eight tier ordinals**
  (`TIER_ORDINALS` in `resumeJobs.ts:23`), so older expansions fall outside it,
  but it sees kills that were never logged. SlashWho reads Warcraft Logs reports, so it reaches back
  to MoP and shows raid nights, but it can only attribute kills that reached a report.

### Cutting Edge is stronger evidence in SlashWho

- `raasta`: both sides agree (the bot marks Bad Alts' `VS / DR / MQD` and `Manaforge Omega` stints
  CE; SlashWho holds 10 account achievements). The bot's CE works when a full clear is visible in a
  stint.
- `ragedoom`: the bot produces **no** CE at all, while SlashWho holds **4** CE achievements. Cutting
  Edge achievements are account-wide, so this is proof about the account that the bot's kill-date
  inference cannot reach, regardless of which character earned it.
- SlashWho's per-raid `cuttingEdge` field was `null` in all three dossiers even where
  `cuttingEdges[]` was populated; only the achievement list is usable as a CE signal today.

### Depth of raid evidence

The bot renders a curated five-tier, three-boss-per-tier view (about 2,000 characters of Markdown).
SlashWho holds 29 tiers per dossier, including first kills with historic world ranks, kill rosters,
wipes, and first-kill and best parses. That is more than a Discord message can usefully show and is
the strongest argument for linking the dossier rather than reproducing it.

### Honest incompleteness

SlashWho's `limitations[]` names the shortfall per character (`history_limit`,
`current_content_evidence_withheld`, `unmatched_encounter`) with `affects` and `recovery`. The bot
has a rate-limit footer and a sweep-truncation note, but cannot say "this character's older kills
were cut off" — which SlashWho says for four of the eight `raasta` characters. Officers currently
cannot tell a thin history from a truncated one.

## Integration mechanics

### Intake and linking

- The bot's `/apply` characters live only in SQLite. To make one dossier out of a multi-character
  application, the bot must `POST /api/dossiers` for the first character and then
  `POST .../connected-characters` for each additional character. That is **one search per declared
  character** against the 60/hour bot bucket, plus one read per poll.
- The sheet watcher already does the equivalent internally (`manualConnections.add` with origin
  `applicant_sheet`) without spending HTTP quota, so the two intakes behave differently.
- `POST .../connected-characters` is the only mutation route that does not pass through
  `authorizeConnectionMutation`, and that guard is a write-rate limiter rather than an access gate
  (anonymous callers are allowed 10/hour, bots 60). It is also the only way to link characters, so
  the bot would depend on a write path that cannot carry an application origin.
- There is no way to tell SlashWho "this character is the applicant's declared main" apart from
  linking it; provenance in the payload is limited to
  `submitted | raiderio_declared | fingerprint_derived | manually_added` and no confidence.

### Freshness vs top-ups

The bot re-sweeps when a link is pasted into the thread and refreshes on demand. SlashWho serves an
immutable snapshot for 24 hours and only recollects after a `POST` for a stale root. A late-pasted
alt can be linked as a connected character (which searches it), but nothing re-reads the existing
characters' evidence. The bot's top-up behaviour has no direct equivalent.

### Failure modes

- `404 discovery_not_ready` while the first snapshot is being assembled.
- `research=partial` with limitations is a normal outcome, not an error; the bot must map limitation
  codes into the officer-facing copy rather than showing an empty section.
- `429 rate_limited` with `Retry-After`; the bot's current pause/resume machinery would become a
  wrapper around SlashWho's quota rather than three providers' quotas.
- A SlashWho outage is an intel outage. There is no fallback path in the bot unless one is built.

### Cost and latency

- One bot run for `ragedoom` (2 characters) compared **1,820 candidate characters** (1,699 cache
  rows) and spent **264.1 Warcraft Logs points** in **49 s**. `raasta` (8 characters) compared 1,901
  and spent **547.7 points** in 94 s. The WCL spend is dominated by the alt log sweep, not discovery.
- SlashWho enforces `EVIDENCE_REQUEST_CAP=500` per run, `EVIDENCE_PARSE_REQUEST_CAP=24`, and a
  `EVIDENCE_POINTS_RESERVE=3500` gate. Its *sheet watcher* admits at most 5 new characters a day; a
  web `POST` is queued directly against the search quota instead.
- **Not measured:** time from `POST` to a ready dossier for a character SlashWho has never seen. Every
  sample already had a snapshot or a collection in flight, and triggering new collections would have
  spent SlashWho's provider budget rather than measuring the contract. This is the one number the
  next step should collect on SlashWho's test environment.
- Whether the two services share Warcraft Logs credentials is a deployment fact, not visible from
  either repo. If they do, the 9,000 points/hour is one budget and moving the work saves nothing;
  if they don't, the bot's 264–548 points per applicant move onto SlashWho's account.

### Data handling

SlashWho never stores BattleTags, Discord handles, or raw provider responses, and it is unlisted
(`noindex`). The bot would be sending it character identities it already stores. SlashWho's removals
process is in `docs/operations/removals.md`.

### China

`regionSchema` is `us | eu | kr | tw` (`packages/contracts/src/character.ts:3`), and the fingerprint
sweep explicitly does not support CN. Moving to SlashWho would hard-code the current limitation of
#86 rather than leaving room to fix it.

### Consumers that must keep working

- `trialRealm()` reads `applicant_intel_jobs.character_realm/region`
  (`src/functions/raids/ensureTrialRaiders.ts:24`).
- #106 needs findings with `source`, `confidence`, and `discord_status`.
- The refresh button and link harvester gate on an existing job row
  (`src/interactions/application.ts:267`, `src/functions/applications/harvestLinkedCharacters.ts:40`).
- `confirmDiscord` has no SlashWho equivalent, by design — SlashWho stores no Discord handles.

## Officer-facing shape

The current three messages are a deliberate reading order: who the characters are, where they have
raided, what they have killed. A SlashWho-backed version can keep that shape from dossier fields:

| Current message | SlashWho field |
|---|---|
| Found characters, source + confidence | `characters[]` (`source`, `className`, `guild`), minus confidence |
| Guild history, dates, kills, CE | `guildHistory[]` plus `cuttingEdges[]` — and CE becomes a fact |
| Mythic logs, per-tier depth, first kills, wipes | `raids[].bosses[]` (`firstKill`, `bestParses`, `wipes`) |
| Rate-limit / incomplete footer | `research` plus `limitations[]` |
| — | A dossier link officers can open for rosters, ranks, and parses |

Two candidate shapes: keep three messages but source them from SlashWho, or publish one compact
summary with a link to the dossier. The second is much less code and gives officers more evidence,
but it moves the detail behind a click and outside the thread.

## Recommendation

**Hybrid, not replacement.** Use SlashWho as the evidence engine; keep the bot-side pieces that
SlashWho cannot or should not own:

1. **Keep** link harvesting, the job/message plumbing (or a thinner version of it), and the
   Discord-confirmation pass. SlashWho stores no Discord identity, and the confirmation pass is the
   only ownership signal that is not self-asserted.
2. **Seed** one dossier per application from the first declared character, then link every other
   declared character with `POST .../connected-characters`. This is what removes the root dependence
   measured above; it is one search per declared character against a 60/hour bucket.
3. **Move** alt discovery, guild history, and Mythic-log collection to SlashWho, which already does
   more of the last two and has a durable snapshot model. Alt discovery at a guilded root was at
   parity in both measured samples, and better where the bot is blind (unguilded roots).
4. **Mirror** the minimal findings the bot's other features need (`source`, no confidence, realm) into
   `applicant_intel_findings`, so #106 and `trialRealm` are unaffected.
5. **Render** a compact summary with a dossier link, and keep the existing embeds behind a flag for a
   release, so officers can compare before the old path is deleted.

Why not replacement: the Discord confirmation has no SlashWho equivalent, CE and parse evidence are
better presented as a dossier link than as a longer embed, and the bot still needs a local record of
what the applicant declared for trials and #106.

Why not keep as-is: the bot's CE misses account-wide achievements, its guild history stops eight tiers
back, its raid view stops at five tiers, it cannot say which evidence is truncated, and an unguilded
applicant gets almost nothing. SlashWho fixes all five, and its discovery is at least as good when the
dossier is seeded with the declared characters.

Three things must be confirmed before the ADR: whether the two services share Warcraft Logs
credentials, whether officers accept a dossier link in place of the three detailed embeds, and the
shape of the bot-facing SlashWho endpoint (a separate issue in the SlashWho tracker) — in particular
an authenticated create that links all declared characters with an application origin.

**Follow-ups filed:** [Erilla/SlashWho#916](https://github.com/Erilla/SlashWho/issues/916) proposes the
authenticated `/api/v1` contract; #124 is the bot-side consumer, buildable against a fake client before
the API lands.

## Reproduction

The SlashWho side needs nothing but `curl`:

```sh
curl https://slashwho.com/api/dossiers/recent
curl https://slashwho.com/api/dossiers/eu/kazzak/raasta
```

The bot side was measured with a throwaway `tsx` script (not committed): it created a temporary
SQLite database, called `startIntelJob()` with three message ids, and ran `runJob()` with the exact
dependency wiring from `resumeApplicantJobs()` in `src/functions/applications/intel/resumeJobs.ts`,
capturing `editMessage` instead of editing Discord. The three message bodies quoted above are that
capture. Warcraft Logs points came from a direct `rateLimitData` query before and after. Re-running
it means copying that wiring, not importing anything new.

A re-runnable version belongs in `scripts/` only if the investigation continues past the decision;
committing it now would add a live-provider script that typecheck and lint must carry for a one-off
question.

# 0001 — SlashWho as the applicant-intel evidence engine

- **Status:** Accepted (2026-11-21). Built behind `SLASHWHO_INTEL_ENABLED`, default off.
- **Issues:** #121 (investigation), #124 (consumer). SlashWho side: Erilla/SlashWho#916, shipped in
  Erilla/SlashWho#917.
- **Evidence:** [`docs/research/2026-10-22-slashwho-applicant-intel-comparison.md`](../research/2026-10-22-slashwho-applicant-intel-comparison.md).

## Context

The applicant-intel job runs its own multi-provider pipeline (`discoverAlts`, `confirmDiscord`,
`gatherMythicLogs`, Raider.IO kill-date aggregation) and publishes three paged messages per application.
Measured against SlashWho on three real applicants, the bot's alt discovery was at parity at a guilded root
and blind at an unguilded one (1 character against 3), and SlashWho was materially better on evidence:
account-wide Cutting Edge, world ranks, older guild history, and per-character limitations that say what is
missing. A run costs the bot 31–94 s and 264–548 Warcraft Logs points.

SlashWho is the maintainer's own service. It now exposes an authenticated bot API (`/api/v1`) that creates
one dossier from every declared character and returns a chat-sized summary.

## Decision

**Hybrid, not replacement.** SlashWho becomes the evidence engine for alt discovery, guild history and
Mythic logs. The bot keeps the parts SlashWho cannot or should not own:

- link harvesting from the application thread, the job row and its placeholders, top-ups, rate-limit
  pause/resume and the officer Refresh control;
- the Discord confirmation pass — SlashWho stores no Discord identity, and this is the only ownership signal
  that is not self-asserted;
- the `applicant_intel_*` tables as the source of truth. The summary is mirrored into findings
  (`raiderio_declared` → `raider.io`, `fingerprint_derived` → `fingerprint` with no score,
  `manually_added` and undeclared `submitted` → `linked`; declared characters stay `application`) and into
  the stored guild history, so #106, `trialRealm` and the existing buttons read the same rows.

The legacy pipeline stays in the tree and is what runs with the flag off, byte-for-byte as before. It is not
deleted until the SlashWho path has run for real applications.

**Shared Warcraft Logs credentials.** The bot and SlashWho use the same Warcraft Logs account, so the 9,000
points/hour is one budget. Moving the sweep saves bot code and complexity, not points. It follows that a
SlashWho failure must not silently fall back to the legacy sweep: that would spend the same shared budget
twice. `SLASHWHO_FALLBACK_SWEEP` therefore defaults to `false`, and when an operator turns it on the
fallback logs a warning every time it fires.

**One compact summary embed plus the dossier link.** Officers get one bounded embed — characters found (with
source and Discord verdict), the most recent guilds, Mythic progression highlights for the latest raids,
the Cutting Edge count, and SlashWho's limitations — and a link to the full dossier for rosters, parses,
world ranks and older raids. This replaces #124's "publish the same three messages". The three message
positions are still reserved at submission (so flag-off output and `/test applicant_intel` are unchanged and
the reading order above the voting controls holds); with the flag on, the guild-history and logs positions
are edited to a one-line pointer at the summary.

**Paging does not apply with the flag on.** The summary is capped per section (eight characters, three
guilds, three raids, four limitation lines, each with an "…and N more in the dossier" line) and always fits
one embed, so it is published without paging metadata and any page row a legacy run left is cleared. The
`intelpage` / `intelguildpage` handlers are unchanged and still serve legacy jobs.

**A fingerprint finding with no confidence is not 100%.** SlashWho keeps no fingerprint score
(`confidence` is always `null` in v1). `findingLine` used to render `confidence ?? 100`, which would show an
unscored match as "100% confidence"; it now reads "fingerprint match, no score". The `?? 100` stays for
stated facts such as a Raider.IO-declared alt, which the legacy sweep records at 100 anyway.

## Failure behaviour

Every outcome ends in published copy; nothing is left reading "searching…".

| Situation | Behaviour |
|---|---|
| `ready` / `partial`, and summary and status agree on `snapshotId` | Mirror, run the Discord pass, publish; job `done`. `partial` adds a note and the limitations |
| Still `collecting` at `SLASHWHO_JOB_DEADLINE_MS` (10 min) | Publish what exists with a "still collecting" note and the link; job `done`. Collection carries on server-side; Refresh re-reads it |
| `429` (or an open `slashwho` breaker) | Pause with SlashWho's `Retry-After`, publish the rate-limit note, resume on a later tick without re-creating the dossier. Abandon with honest copy after the usual attempt/age limits |
| `401` / `403`, `400 invalid_character_url`, `404` on create or status, a response that breaks the contract | Terminal: log once, publish "research unavailable" with the declared characters, job `done`. A `400`/`401` does not count towards the `slashwho` breaker, so a bad key keeps reading as an auth failure rather than turning into a rate limit for later jobs |
| Transport failure / `5xx` after `httpRequest`'s retries, **before** the dossier exists | Same "unavailable" copy, unless `SLASHWHO_FALLBACK_SWEEP=true`, which runs the legacy sweep for that job |
| Transport failure / `5xx` **after** the dossier exists | Pause and retry with the usual backoff, publishing "SlashWho could not be reached" with the retry time: SlashWho keeps collecting regardless, so the bot looks again rather than giving up. Abandon with the same copy after the usual attempt/age limits. The fallback never fires here |

A link pasted into the thread mid-run is added to the dossier on the next poll and listed; one pasted after
the job finished reopens it, and the reopened run reuses the stored dossier rather than creating a new one.

## Consequences

- Officer output moves detail behind a click. That is deliberate: the dossier carries far more than three
  embeds could, and SlashWho's limitations make incompleteness explicit.
- A SlashWho outage is an applicant-intel outage by default. Before the dossier exists, officers see "research
  unavailable" and can press Refresh, and the operator can opt into the fallback knowing it spends the shared
  Warcraft Logs budget; after it exists, the job waits out the outage and publishes when SlashWho answers.
- The bot depends on a second deployable's release cadence. The client validates every response at the
  boundary, ignores unknown fields, and fails loudly (as "unavailable") on a breaking change.
- SlashWho's region list excludes CN, so this hard-codes #86's current limitation for the flag-on path.
- Not in scope: deleting the legacy pipeline, scheduled refreshes, re-publishing a dossier that finishes after
  the deadline, and calling `/refresh` (the only call that spends SlashWho's provider budget on a read).

# Inactive raiders — Design

**Date:** 2026-07-09
**Status:** Approved (brainstorming) — pending implementation plan
**Scope:** `src/functions/raids/syncRaiders.ts`, `raiders` schema + migration, and the
roster-enumerating queries that must hide inactive raiders. Plus documentation.

## Problem

When a raider disappears from the Raider.io guild roster, `syncRaiders`
(`syncRaiders.ts`) sets `missing_since` on the first sync they're absent, then —
after a 24h grace period — logs a **warning on every subsequent sync** (every 10
minutes) and never does anything else. Two consequences:

1. A raider who has genuinely left the guild produces a `warn` log every 10
   minutes, indefinitely, until an officer manually ignores them.
2. That raider still appears in `get_raiders` (`raiders.ts:110` runs an
   unfiltered `SELECT * FROM raiders`), indistinguishable from an active raider.

We want raiders who have been missing past the grace period to be moved to an
**inactive** state: hidden from `get_raiders` (and other roster views), no longer
warned about, but retained in the DB — including their Discord link and history —
so they can be **auto-reactivated** if they return to the roster.

## Decisions (from brainstorming)

- **Threshold:** reuse the existing 24h grace period (`GRACE_PERIOD_MS`). Crossing
  24h missing promotes a raider to inactive instead of just logging a warning.
- **Reactivation:** automatic. If an inactive raider reappears in the roster, flip
  them back to active silently (no notification), keeping their row and Discord
  link intact.
- **Visibility:** none. Inactive raiders simply disappear from `get_raiders`.
  No dedicated list view, no `include_inactive` flag, no manual reactivate command
  (YAGNI — auto-reactivation covers the return case).

## Representation

Add a nullable `inactive_since` timestamp column to the `raiders` table, mirroring
the existing `missing_since` pattern. `NULL` = active; a value = inactive, and the
value records **when** the raider was retired. This is chosen over a plain boolean
because it is both the flag and the timestamp in one column, and over a separate
`inactive_raiders` table because that would require moving rows on every state
change and teaching every lookup about two tables.

## State machine (single `raiders` row)

| State | `missing_since` | `inactive_since` | Shown in `get_raiders`? |
|---|---|---|---|
| **Active** (present in roster) | `NULL` | `NULL` | yes |
| **Missing** (absent < 24h, grace) | set | `NULL` | yes (unchanged from today) |
| **Inactive** (absent ≥ 24h) | set (kept) | set | no (hidden) |
| **Reactivated** (reappears in roster) | `NULL` | `NULL` | yes |

`missing_since` is deliberately **kept** (not cleared) when a raider becomes
inactive. This means every existing `... AND missing_since IS NULL` filter already
excludes inactive raiders for free, and the two timestamps stay meaningful:
`missing_since` = when first detected absent, `inactive_since` = when promoted.

## `syncRaiders` changes

The absent-raider branch (`syncRaiders.ts:51-71`) is rewritten. For each DB raider
**not** in the filtered API roster:

- `missing_since` is `NULL` → set `missing_since = now`, count `markedMissing++`
  (unchanged).
- `missing_since` set, elapsed ≥ `GRACE_PERIOD_MS`, `inactive_since` is `NULL` →
  set `inactive_since = now`, emit **one** `info` log
  (`Raider "X" marked inactive after >24h missing (since <missing_since>)`), count
  `markedInactive++`. This replaces the previous repeating `warn`.
- `missing_since` set, elapsed ≥ `GRACE_PERIOD_MS`, already inactive → **do
  nothing** (no repeat log). This fixes the infinite-warning problem.
- `missing_since` set, elapsed < `GRACE_PERIOD_MS` → do nothing (still in grace).

The returned-raider branch (`syncRaiders.ts:74-79`) is extended: for each DB raider
**in** the API roster where `missing_since` **or** `inactive_since` is non-null,
clear **both** to `NULL` (auto-reactivate). Emit an `info` log only when
`inactive_since` was set (`Raider "X" reactivated (returned to roster)`), count
`reactivated++`.

New-raider insertion (`syncRaiders.ts:89-116`) is unchanged: `dbRaiderMap` is built
from all DB raiders (including inactive ones), so a returning raider is matched by
the returned-raider branch and never double-inserted.

The completion summary log gains `markedInactive` and `reactivated` counts;
`alreadyMissing` is removed (superseded by the inactive state).

## Schema + migration

- `schema.ts`: add `inactive_since TEXT` to the `raiders` `CREATE TABLE`.
- `db.ts`: add migration block `if (currentVersion < 5)`. Because fresh databases
  get the column from `createTables` (which runs before migrations), the
  `ALTER TABLE raiders ADD COLUMN inactive_since TEXT` must be **guarded** by a
  `PRAGMA table_info(raiders)` check that skips the ALTER when the column already
  exists. Bump `schema_version` to 5 inside a transaction (matching the existing
  migration style).
- `types/index.ts`: add `inactive_since: string | null` to `RaiderRow`.

## Query sites that must exclude inactive

Add `inactive_since IS NULL` to these roster-enumerating queries:

- **`commands/raiders.ts:110`** — `get_raiders` (the primary requirement).
- **`commands/raiders.ts`** — the `previous_highest_mythicplus` and
  `previous_great_vault` manual report subcommands (same reports as the
  scheduled weekly job).
- **`commands/status.ts:82`** — raider total/linked count, so status reflects the
  active roster.
- **`functions/raids/alertHighestMythicPlusDone.ts:131`** — weekly M+ report.
- **`functions/raids/alertSignups.ts:105`** — signup roster.
- **`functions/raids/autoMatchRaiders.ts:22`** — the already-linked-user set, so an
  inactive raider's Discord user does not block auto-matching a new character.

Already covered (they filter `missing_since IS NULL`, and inactive rows keep
`missing_since` set): `check_missing_users` (`raiders.ts:231`),
`refreshLinkingMessages.ts:76`, and the unlinked count in `autoMatchRaiders.ts:29`.

**Deliberately not changed:**

- `syncRaiders.ts:20` — must read **all** rows, including inactive, for the state
  machine to work.
- `interactions/loot.ts` and `functions/loot/updateLootPost.ts` — keyed by the
  Discord user who reacted, not a roster enumeration; out of scope.
- By-`character_name` lookups (`interactions/raider.ts`,
  `updateRaiderDiscordUser.ts`) — operate on a specific character regardless of
  state.

## Documentation

- `.claude/skills/raiders.md`:
  - Fix the stale sync step "Remove stored raiders not in roster" — the sync does
    not delete missing raiders; it flags them and (new) retires them to inactive.
  - Document the missing → inactive → reactivate state machine and the 24h
    threshold.
  - Add `inactive_since` to the `raiders` columns list.
  - Note that `get_raiders` (and the other roster views) hide inactive raiders.
- This design doc lives in `docs/superpowers/specs/`.

## Testing

Unit / integration coverage (`tests/unit` for `syncRaiders`,
`tests/integration/raids-flow.test.ts`):

- Missing < 24h → stays active, `inactive_since` remains `NULL`, still in
  `get_raiders`.
- Missing ≥ 24h, not yet inactive → `inactive_since` set, single `info` log,
  hidden from `get_raiders`.
- Already inactive and still absent → no state change, **no** repeated log.
- Inactive raider reappears in roster → `missing_since` and `inactive_since` both
  cleared, one reactivation `info` log, back in `get_raiders`.
- `get_raiders` (and the four consistency sites) exclude inactive rows.
- Migration: an existing DB (schema < 5) gains the `inactive_since` column without
  error, and re-running migrations is idempotent.

## Out of scope

- Any user-facing view of inactive raiders (list command, filter flag).
- A manual reactivate command.
- Notifying a channel on inactivation or reactivation.
- Excluding inactive raiders from loot lookups.

# Raider auto-match improvements — Design

**Date:** 2026-07-04
**Status:** Approved (brainstorming) — pending implementation plan
**Scope:** `src/functions/raids/autoMatchRaiders.ts` and a new `normalizeName` helper.

## Problem

When the roster sync adds a new raider with no linked Discord user, the bot
posts a linking suggestion in `#raider-setup`. Today `autoMatchRaiders`
(`autoMatchRaiders.ts:26-51`) suggests a user purely by **exact, case-sensitive,
un-normalised name equality** against every guild member, and it has two gaps:

1. It does **not** check whether a name-matched member is already linked to
   another raider — so it can suggest the same Discord user for two characters.
2. It has no fallback when a name match fails, even in the common small-guild
   case where there is obviously only one candidate left.
3. Exact matching misses real-world name differences: accents (`Hephaestüs`),
   realm suffixes (`Shadowleif-Silvermoon`), casing, and decorative characters
   in Discord nicknames (`✨Shadowleif✨`).

This design addresses all three. Everything downstream — the Confirm/Reject
card, the "select a different user" dropdown, and `raider_identity_map`
persistence — is unchanged; we only change **which** user (if any) gets
suggested.

## Definitions

- **Already linked (user):** a Discord user ID that appears as the
  `discord_user_id` of any row in the `raiders` table (non-null). This is the
  set excluded from suggestions and used to compute "unlinked" pools. The
  broader `raider_identity_map` history is intentionally **not** used here.
- **Raider-role member:** a guild member who holds the configured
  `raider_role_id` (read from the `config` table, set via `/setup set_role`).
- **Unlinked Raider-role member:** a Raider-role member who is not a bot and
  whose ID is not in the already-linked set.

## Behaviour

### Change 1 — exclude already-linked users from name matches
Before counting name matches for a raider, drop any candidate member whose ID is
in the already-linked set (and any bot — see Extras). Then apply the existing
rule to the remaining candidates:

- exactly **1** candidate → suggest it,
- **0** candidates → no match (→ unmatched alert, or the elimination path),
- **2+** candidates → ambiguous, skip (→ unmatched alert).

Effect: the bot never suggests linking a second character to someone already
linked.

### Change 2 — single-candidate elimination short-circuit
Checked **first**, before name-matching. If **both** of these are exactly 1:

- total unlinked raiders in the DB (`discord_user_id IS NULL`) **== 1**, and
- unlinked Raider-role members **== 1**,

then suggest that one member for that one raider, log the reason (see Extras),
and **return immediately without name-matching**.

Rationale: in a small guild a clean global 1:1 is a strong enough signal to act
on directly. This is a deliberate choice to prefer simplicity over a
(rare) case where a name match would point to a *different* member — the officer
still confirms the suggestion, so a wrong elimination guess is correctable via
the existing Reject / dropdown.

If `raider_role_id` is not configured, the elimination path is skipped (logged
at debug), mirroring `assignRaiderRole`'s tolerance of missing config.

## Extras (agreed in)

- **Filter out bots.** Bot accounts are excluded from both the name-match
  candidate set and the eligible-member pool. A bot can never be a raider, so
  this prevents bad suggestions and stops a bot from spoiling a clean 1:1 count.
- **Log the elimination reason.** When the elimination path fires, emit an
  `info` log, e.g. `elimination match: Shadowleif -> @Bob (sole unlinked raider
  + sole unlinked Raider-role member)`. Because elimination can suggest someone
  whose name does not match the character, this keeps the suggestion explainable.
- **Name normalization** (Change applies to name-matching only — see below).

## `normalizeName` helper

A small **pure** helper (new file, e.g. `src/functions/raids/normalizeName.ts`),
applied symmetrically to the WoW character name and to each Discord name
(server display name, global display name, username) before comparison.

Steps, **in order**:

1. **Drop realm suffix** — take the substring before the first `-`. WoW
   character names cannot contain `-` (it separates name from realm), so this is
   a no-op for the character side and strips `-Realm` from Discord names.
2. **Fold accents to ASCII** — `str.normalize('NFD').replace(/[̀-ͯ]/g, '')`.
   The character class is the combining-diacritical-marks range U+0300–U+036F
   (i.e. `/[̀-ͯ]/g`). This decomposes accented letters and removes the
   combining marks, so `ü→u`, `é→e`, `ï→i`, `ñ→n`. This is what makes
   `Hephaestüs` == `Hephaestus`.
   **Order matters:** accent-folding must happen before step 4, or the accented
   characters would be stripped as non-ASCII and produce a worse match.
3. **Lowercase.**
4. **Strip remaining non-alphanumerics** — remove anything outside `[a-z0-9]`
   (spaces, punctuation, emoji). `✨Shadowleif✨ → shadowleif`.

Known limitation: NFD folds the common Latin accents but a few letters do not
decompose (`ø`, `ł`, `ß`). These are left as-is for now; if such names occur in
the guild, add a small explicit replacement map. Not built unless needed
(YAGNI).

Name matching becomes `normalizeName(memberName) === normalizeName(characterName)`
instead of the current exact/lowercase equality. The ambiguity rule (2+ →
skip) applies to normalized matches unchanged.

## Consolidated algorithm — `autoMatchRaiders(guild, unlinkedRaiders)`

1. If `unlinkedRaiders` is empty → return `[]`.
2. Read from the DB once:
   - `linkedUserIds`: set of non-null `discord_user_id` from `raiders`.
   - `totalUnlinkedCount`: count of `raiders` with `discord_user_id IS NULL`.
   - `raiderRoleId`: `config` table value for `raider_role_id` (may be absent).
3. `guild.members.fetch()`. On failure → log error, return `[]` (unchanged).
4. **Elimination short-circuit:** if `totalUnlinkedCount === 1` and
   `raiderRoleId` is set:
   - `eligible` = members that hold `raiderRoleId`, are **not** bots, and are
     **not** in `linkedUserIds`.
   - if `eligible.length === 1`: suggest `{ raider: <the sole unlinked raider
     from unlinkedRaiders>, suggestedUser: eligible[0] }`, log the elimination
     reason, and **return** that single match.
   - otherwise fall through to step 5.
5. **Name matching:** for each raider in `unlinkedRaiders`:
   - `candidates` = members where `normalizeName(display/global/username)` equals
     `normalizeName(raider.character_name)`, excluding bots and members in
     `linkedUserIds`.
   - `candidates.length === 1` → add match; `> 1` → ambiguous, log debug, skip;
     `=== 0` → no match.
6. Return matches. (Log the total found count, as today.)

## Data / dependencies

`autoMatchRaiders` gains a DB read (`getDatabase`) and reads `raider_role_id`
from the `config` table. It already receives `guild` (for member roles) and the
unlinked-raider batch. No schema changes. No new config.

## Testing

Extend `tests/unit/autoMatchRaiders.test.ts`:

- **Change 1:** name match resolves to an already-linked user → excluded (no
  suggestion / falls through).
- **Change 1:** two name matches, one already linked → the other is the sole
  candidate → suggested.
- **normalizeName (unit):** `Hephaestüs` == `Hephaestus`; `Shadowleif-Silvermoon`
  == `Shadowleif`; `✨Shadowleif✨` == `Shadowleif`; case-insensitive.
- **Elimination fires:** 1 unlinked raider + 1 unlinked Raider-role member, no
  name match → suggested; info log emitted.
- **Elimination suppressed:** when unlinked-raider count > 1; when eligible
  member count > 1; when `raider_role_id` is unset.
- **Bot filtering:** a bot with a matching name is never suggested; a bot with
  the Raider role does not count toward the eligible-member 1:1.

## Out of scope

- **WCL trial-log name matching.** `getTrialLogs` compares against WCL's stored
  `player.name` with exact case/accents; applying `normalizeName` one-sided
  there would break matching. Any symmetric normalization of WCL log lookups is
  a separate change (planned in its own session).
- **`raider_identity_map` normalization.** The "remembered" auto-link in
  `syncRaiders` keeps its current simple lowercase lookup; normalizing stored
  identity-map keys is a possible follow-up, not part of this change.

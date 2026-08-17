# Trials as roster members

**Date:** 2026-08-17
**Status:** Approved, ready for implementation plan

## Problem

The Wednesday signup reminder named two new trials as plain text while pinging everyone else:

> The following raiders have not signed up for **Wednesday**:
> etav, @jovaz, neralia, @Skadi

`alertSignups` resolved mentions from the `raiders` table alone. Neither Etav nor Neralia had a row, so both fell through to the bold-name branch — even though the bot knew both Discord accounts (Neralia's in `trials.discord_user_id`, Etav's in `raider_identity_map`).

The immediate ping bug is already fixed by `resolveSignupMentions` (raiders → active trials → identity map). This spec addresses the underlying cause: **a trial is not a roster member as far as the `raiders` table is concerned.**

### Why neither trial had a row

`raiders` is populated exclusively by `syncRaiders` from the Raider.IO guild roster, filtered to `ROSTER_RANKS = [0, 1, 3, 4, 5, 7]` (`src/services/raiderio.ts:21`). New trials fail that gate two different ways:

| Character | Cause                                                                                                                            |
| --------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Neralia   | In the Raider.IO roster at **rank 8**, outside `ROSTER_RANKS`. A fresh guild invite sits at rank 8 until an officer promotes it. |
| Etav      | Absent from the Raider.IO roster entirely — Raider.IO only knows characters it has crawled.                                      |

Widening `ROSTER_RANKS` is not the answer: rank 8 holds 161 of the guild's 314 Raider.IO-known members, the whole social and alt population. The current filter is exact — it yields precisely the 24 active raiders in production.

### Two further defects found while investigating

Both affect this work and are fixed as part of it:

1. **`raiders` rows are inert once written.** No code anywhere issues `SET rank`, `SET realm` or `SET class`. An in-game promotion or realm transfer never propagates to an existing row. Without fixing this, any realm we guess for a synthesised row would be permanent — and a wrong realm silently drops that character from the M+ alert, which looks characters up by name and realm.
2. **An unlinked row never picks up a later link.** `syncRaiders` consults `raider_identity_map` only when inserting a new row. A row already present with `discord_user_id IS NULL` stays unlinked even after the map learns the answer.

### What "removed from the roster" actually means

Worth stating precisely, because it is easy to misread. `syncRaiders` never deletes a row. Absent characters get `missing_since` stamped on the first sync, then `inactive_since` 24 hours later; both clear automatically if the character reappears. The row is kept forever. What `inactive_since` does is **hide** the raider — every consumer filters on `inactive_since IS NULL`. Production currently holds 29 rows, 24 of them active.

The consequence: inserting a row for a trial is not sufficient on its own. The next sync would stamp it missing and hide it within a day.

## Design

**A trial with `status = 'active'` has a `raiders` row, and that row is exempt from the missing/inactive machinery.**

### Rules in `syncRaiders`

`syncRaiders` remains the owner of the table. Three rules are added, in this order inside the existing transaction:

1. **Ensure.** Before the absence pass, upsert a row for every active trial that lacks one. Newly inserted rows with no Discord link join the existing `newUnlinkedRaiders` return value, so auto-match and the linking message fire for them exactly as for any new raider. Running the ensure step first means a row inserted this run cannot be stamped in the same run.
2. **Exempt.** Skip missing/inactive stamping for active-trial characters, and clear `missing_since`/`inactive_since` when a previous sync already stamped one. This self-heals any trial stamped before this ships.
3. **Refresh.** When a character is present in the Raider.IO roster, update `realm`, `region`, `rank` and `class` where the API disagrees with the stored row. This fixes defect 1 above for the whole roster, not just trials.

When a trial closes, nothing special happens: the exemption stops applying and normal rules resume. A promoted trial sits at a raiding rank, so the roster carries them anyway. A rejected one has left the guild and is hidden 24 hours later, row retained as always.

### Guards

- A character listed in `ignored_characters` is never resurrected by the ensure step. `/raiders ignore` deletes the row deliberately, and the ensure step must not undo that.
- An existing non-null `discord_user_id` is never overwritten. A **null** one is filled from the trial record, which closes defect 2 for trials.
- Matching is case-insensitive throughout, consistent with how `syncRaiders` and `linkCharacterIdentity` already compare names.

### Components

**`src/functions/raids/ensureTrialRaiders.ts`** — one idempotent unit, so the two call sites stay consistent by construction:

- `ensureRaiderForTrial(db, trial): 'inserted' | 'linked' | 'exists' | 'ignored'` — the single insert path. Returns which branch it took, for logging and for tests.
- `ensureRaidersForActiveTrials(db): RaiderRow[]` — loops active trials, returns the freshly inserted rows that have no Discord link.
- `trialRealm(db, trial): { realm: string; region: string }` — reads `applicant_intel_jobs.character_realm`/`character_region` via the trial's `application_id`; falls back to the `silvermoon`/`eu` guild default. `rank` and `class` are left NULL and filled by the refresh rule once the character appears in the roster.

**`acceptApplication`** calls `ensureRaiderForTrial` immediately after `createTrialReviewThread`, best-effort and non-fatal like the surrounding steps, so the row exists within seconds instead of waiting up to ten minutes for the next sync.

**`resolveSignupMentions`** is unchanged. Once trials have rows, its first branch hits; the trials and identity-map fallbacks remain as belt-and-braces for the window before the first sync, and they cost nothing.

### Data flow

```
accept application ──► trials row (+ discord_user_id) ──► ensureRaiderForTrial ──► raiders row (linked)

/trial command ──────► trials row (± discord_user_id) ──┐
                                                        │  (no direct call; picked up below)
syncRaiders (10 min) ──► ensureRaidersForActiveTrials ◄──┘  ──► raiders row (± linked)
                     ──► exempt active trials from stamping
                     ──► refresh realm/region/rank/class from the roster
```

There are exactly two writers: `acceptApplication` and `syncRaiders`. The `/trial`
command deliberately does **not** call the ensure function itself — a manually
created trial is picked up by the next sync, within ten minutes. Both writers go
through `ensureRaiderForTrial`, so there is one insert path regardless.

### Error handling

The `acceptApplication` call is wrapped and logged as a warning on failure; accepting an application must never fail because a roster row could not be written, and the sync will pick it up regardless. The sync-side steps run inside the existing `db.transaction`, so a throw rolls the whole sync back rather than leaving the table half-updated — matching current behaviour.

## Consequences, deliberately accepted

Trials now appear in `/raiders list`, the `/status` linked count, loot-post eligibility, and the M+ alert. The M+ alert will 404 on characters Raider.IO has not crawled; that is harmless, as 404s are already exempt from the circuit breaker.

## Testing

Unit tests for `ensureTrialRaiders`:

- inserts a row for an active trial with no row
- idempotent: a second call reports `exists` and does not duplicate
- fills a null `discord_user_id` from the trial
- never overwrites a non-null `discord_user_id`
- skips a character in `ignored_characters`
- ignores non-active trials
- realm and region come from the intel job when present, guild default otherwise

Integration tests in `tests/integration/raids-flow.test.ts`:

- an active trial absent from the roster is **not** stamped `missing_since`
- an active trial already stamped has `missing_since`/`inactive_since` cleared
- a **closed** trial absent from the roster **is** stamped (the negative case)
- a character arriving in the roster has `realm`, `region`, `rank` and `class` refreshed
- the sync inserts rows for active trials and returns the unlinked ones for auto-match

One test in the applications suite: accepting an application leaves a linked `raiders` row.

## Out of scope

- Widening `ROSTER_RANKS` (rejected above).
- Backfilling production by hand. The ensure step inserts rows for Etav and Neralia on the first sync after deploy.

# Spec: status tags on the trial-reviews forum

**Date:** 2026-07-04
**Status:** Approved, ready for implementation plan

## Goal

Give each trial-reviews forum thread a Discord forum **tag** reflecting its lifecycle
state, so trials are filterable at a glance: **Active**, **To Be Promoted**,
**Promoted**, **Failed**.

This mirrors the tag pattern already used on the applications forum
(`createForumPost.ts` seeds `availableTags`; `acceptApplication.ts` swaps them).

## Lifecycle → tag mapping

A trial always carries exactly one tag. Outcome (Promoted vs Failed) is **inferred from
the pre-close status** — there is no separate outcome field.

| Action | `trials.status` | Tag applied |
|---|---|---|
| Trial created (`createTrialReviewThread`) | `active` | Active |
| "Mark for Promotion" (`markForPromotion`) | `promoted` | To Be Promoted |
| "Extend 1 Week" (`extendTrial`) | stays `active` | stays Active |
| Close when prior status was `promoted` (`closeTrial`) | `closed` | **Promoted** |
| Close when prior status was `active` (`closeTrial`) | `closed` | **Failed** |

No schema change. Statuses stay `active` / `promoted` / `closed`; the applied tag is
what encodes Promoted vs Failed, decided from the status read immediately before close.

## Components

- `ensureTrialForumTags(forum): Map<string, string>`
  - Additively creates any of the four tags missing from the forum's `availableTags`
    (via `setAvailableTags`, preserving existing tags), returns a name→id map.
  - Called inside `getOrCreateTrialForum`. Seeding tags is safe and is **not** backfill —
    it only makes the tags selectable.
- `applyTrialTag(thread, tagName): Promise<void>`
  - Resolves the tag id from the parent forum's `availableTags` and calls
    `thread.setAppliedTags([tagId])` (a trial has exactly one status → one tag).
  - No-ops gracefully if the tag or parent forum can't be resolved (logs a warning),
    so it never breaks the surrounding trial action.
- Wiring:
  - `createTrialReviewThread` — pass `appliedTags: [activeTagId]` in `threads.create`
    (tag id obtained from `ensureTrialForumTags`).
  - `markForPromotion` — `applyTrialTag(thread, 'To Be Promoted')`.
  - `closeTrial` — read `trial.status` **before** the `UPDATE`, choose
    `status === 'promoted' ? 'Promoted' : 'Failed'`, and `applyTrialTag(...)` **before**
    archiving/locking the thread (an archived/locked thread can't be retagged cleanly).

## Backfill: new trials only

- No existing threads (live or closed) are retagged.
- The forum's `availableTags` are still ensured so new trials can use them.
- Pre-feature active threads that later transition (mark/close) will have the correct
  tag applied at that point via `applyTrialTag`, which sets tags even if none were
  previously applied. This is acceptable, not special-cased.

## Known tradeoff (inherent to "infer from state")

- A trial already marked **To Be Promoted** cannot be closed as **Failed** (it always
  reads as Promoted), and a trial cannot go Active→Promoted without first being marked.
- This matches the normal happy path (mark → promote in-game → close). Documented as a
  conscious choice; revisitable later (e.g. explicit close-outcome buttons) if needed.

## Testing

Unit tests with mocked forum/thread objects:

- `ensureTrialForumTags` — creates missing tags, is idempotent when all four already
  exist, and preserves unrelated existing tags.
- `applyTrialTag` — resolves name→id and calls `setAppliedTags` with the right id;
  no-ops without throwing when the tag/forum is missing.
- `closeTrial` — Promoted-vs-Failed selection based on the pre-close status.

## Out of scope

- Tag colours/emoji (names only for now; trivial to add later).
- Backfilling historical closed threads.
- Any change to trial status values or the promote-reminder flow.

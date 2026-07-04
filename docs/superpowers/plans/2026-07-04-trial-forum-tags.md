# Trial-Reviews Forum Tags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each trial-reviews forum thread a Discord forum tag reflecting its lifecycle state — **Active**, **To Be Promoted**, **Promoted**, **Failed** — so trials are filterable at a glance.

**Architecture:** One small helper module (`trialForumTags.ts`) exposes `ensureTrialForumTags` (seed the four tags on the forum, additively) and `applyTrialTag` (set a thread's single status tag). It's wired into the three existing lifecycle points: `createTrialReviewThread` (→ Active on create), `markForPromotion` (→ To Be Promoted), and `closeTrial` (→ Promoted or Failed, inferred from the pre-close status). The outcome is derived from `trials.status`; no schema change.

**Tech Stack:** TypeScript (ESM, Node16 — local imports use `.js`), discord.js v14, vitest.

**Spec:** `docs/superpowers/specs/2026-07-04-trial-forum-tags-design.md`

## Global Constraints

- ESM with Node16 resolution: **all local imports use the `.js` extension** even from `.ts` files.
- The four tag names are exactly: `Active`, `To Be Promoted`, `Promoted`, `Failed`.
- A trial thread carries exactly **one** status tag → `applyTrialTag` uses `thread.setAppliedTags([tagId])` (replace, not merge).
- **Ordering is critical:** `markForPromotion` and `closeTrial` both archive/lock the thread at the end (via `closeThread`). Apply the tag **after** the existing `thread.send(...)` (which un-archives the thread) and **before** `closeThread(thread)`. Setting tags on an archived thread fails.
- Outcome on close is inferred from the **pre-close** `trials.status`: `'promoted'` → `Promoted`, otherwise → `Failed`. `closeTrial` reads the trial row before it updates the status, so use that value.
- New trials only — no backfill of existing threads. Seeding `availableTags` (which is additive and safe) is not backfill.
- Tags are names-only (no colour/emoji).
- Mirror the existing applications-forum tag pattern: `createForumPost.ts` (seeding via `setAvailableTags` + refetch) and `acceptApplication.ts`'s `swapForumTag` (resolving a tag id off `parent.availableTags`).

---

### Task 1: `trialForumTags` helper (`ensureTrialForumTags` + `applyTrialTag`)

**Files:**
- Create: `src/functions/trial-review/trialForumTags.ts`
- Test: `tests/unit/trial-review/trialForumTags.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks. Uses discord.js `ForumChannel` / `AnyThreadChannel` and the existing `logger` (`src/services/logger.js`).
- Produces:
  ```ts
  export const TRIAL_TAG_NAMES: readonly ['Active', 'To Be Promoted', 'Promoted', 'Failed'];
  export function ensureTrialForumTags(forum: ForumChannel): Promise<ForumChannel>
  export function applyTrialTag(thread: AnyThreadChannel, tagName: string): Promise<void>
  ```

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/trial-review/trialForumTags.test.ts
import { describe, it, expect, vi } from 'vitest';
import type { ForumChannel, AnyThreadChannel } from 'discord.js';
import { ensureTrialForumTags, applyTrialTag } from '../../../src/functions/trial-review/trialForumTags.js';

describe('ensureTrialForumTags', () => {
  it('adds the four tags additively, preserving existing tags, and returns the refetched forum', async () => {
    const setAvailableTags = vi.fn(async () => {});
    const refetched = { availableTags: [{ id: 'r', name: 'refetched' }] } as unknown as ForumChannel;
    const forum = {
      availableTags: [{ id: 'x', name: 'Existing' }],
      setAvailableTags,
      fetch: vi.fn(async () => refetched),
    } as unknown as ForumChannel;

    const result = await ensureTrialForumTags(forum);

    expect(setAvailableTags).toHaveBeenCalledOnce();
    expect(setAvailableTags.mock.calls[0][0]).toEqual([
      { id: 'x', name: 'Existing' },
      { name: 'Active' },
      { name: 'To Be Promoted' },
      { name: 'Promoted' },
      { name: 'Failed' },
    ]);
    expect(result).toBe(refetched);
  });

  it('is a no-op when all four tags already exist', async () => {
    const setAvailableTags = vi.fn(async () => {});
    const forum = {
      availableTags: [
        { id: '1', name: 'Active' },
        { id: '2', name: 'To Be Promoted' },
        { id: '3', name: 'Promoted' },
        { id: '4', name: 'Failed' },
      ],
      setAvailableTags,
      fetch: vi.fn(),
    } as unknown as ForumChannel;

    const result = await ensureTrialForumTags(forum);

    expect(setAvailableTags).not.toHaveBeenCalled();
    expect(result).toBe(forum);
  });
});

describe('applyTrialTag', () => {
  it('sets the thread applied tags to the single matching tag id', async () => {
    const setAppliedTags = vi.fn(async () => {});
    const thread = {
      id: 't1',
      parent: { availableTags: [{ id: 'a', name: 'Active' }, { id: 'p', name: 'Promoted' }] },
      setAppliedTags,
    } as unknown as AnyThreadChannel;

    await applyTrialTag(thread, 'Promoted');

    expect(setAppliedTags).toHaveBeenCalledWith(['p']);
  });

  it('no-ops when the tag name is not found on the parent forum', async () => {
    const setAppliedTags = vi.fn(async () => {});
    const thread = {
      id: 't1',
      parent: { availableTags: [{ id: 'a', name: 'Active' }] },
      setAppliedTags,
    } as unknown as AnyThreadChannel;

    await applyTrialTag(thread, 'Nonexistent');

    expect(setAppliedTags).not.toHaveBeenCalled();
  });

  it('no-ops when the thread has no forum parent with availableTags', async () => {
    const setAppliedTags = vi.fn(async () => {});
    const thread = { id: 't1', parent: null, setAppliedTags } as unknown as AnyThreadChannel;

    await applyTrialTag(thread, 'Active');

    expect(setAppliedTags).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/trial-review/trialForumTags.test.ts`
Expected: FAIL — cannot find module `trialForumTags.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/functions/trial-review/trialForumTags.ts
import type { AnyThreadChannel, ForumChannel } from 'discord.js';
import { logger } from '../../services/logger.js';

export const TRIAL_TAG_NAMES = ['Active', 'To Be Promoted', 'Promoted', 'Failed'] as const;

/**
 * Ensure the trial-reviews forum has the four status tags. Additive and safe:
 * only creates tags that are missing, preserving any existing ones. Returns the
 * forum (refetched when tags were added, so availableTags carries their ids).
 */
export async function ensureTrialForumTags(forum: ForumChannel): Promise<ForumChannel> {
  const existing = forum.availableTags;
  const missing = TRIAL_TAG_NAMES.filter((name) => !existing.some((t) => t.name === name));
  if (missing.length === 0) return forum;

  try {
    await forum.setAvailableTags([...existing, ...missing.map((name) => ({ name }))]);
    return (await forum.fetch()) as ForumChannel;
  } catch (error) {
    logger.warn('Trials', `Failed to set trial forum tags: ${error}`);
    return forum;
  }
}

/**
 * Set a trial thread's status tag. A trial carries exactly one tag, so this
 * replaces any existing applied tags. No-ops (with a warning) if the tag or
 * the parent forum can't be resolved, so it never breaks the caller's flow.
 */
export async function applyTrialTag(thread: AnyThreadChannel, tagName: string): Promise<void> {
  const parent = thread.parent;
  if (!parent || !('availableTags' in parent)) return;

  const forum = parent as ForumChannel;
  const tag = forum.availableTags.find((t) => t.name === tagName);
  if (!tag) {
    logger.warn('Trials', `Trial forum tag "${tagName}" not found; skipping`);
    return;
  }

  try {
    await thread.setAppliedTags([tag.id]);
  } catch (error) {
    logger.warn('Trials', `Failed to apply tag "${tagName}" to thread ${thread.id}: ${error}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/trial-review/trialForumTags.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/functions/trial-review/trialForumTags.ts tests/unit/trial-review/trialForumTags.test.ts
git commit -m "feat(trials): add trial forum tag helper (ensure + apply)"
```

---

### Task 2: Wire tags into the trial lifecycle (create / mark / close)

**Files:**
- Modify: `src/functions/trial-review/createTrialReviewThread.ts`
- Modify: `src/functions/trial-review/markForPromotion.ts`
- Modify: `src/functions/trial-review/closeTrial.ts`

**Interfaces:**
- Consumes: `ensureTrialForumTags`, `applyTrialTag` from Task 1 (`./trialForumTags.js`).
- Produces: no new exports; behavioural change only.

No unit test in this task — these three functions are Discord + DB integration that the codebase covers via env-gated e2e (`tests/e2e/commands/trials.e2e.ts`, `tests/e2e/flows/trial-alerts.e2e.ts`), not unit tests. The gate here is: `tsc` clean, the full default suite still green (no regressions), and the manual e2e in Task 3. The tag logic itself is unit-tested in Task 1.

- [ ] **Step 1: `createTrialReviewThread.ts` — seed tags and apply Active on create**

Add the import alongside the existing local imports (note the `.js` extension):

```ts
import { ensureTrialForumTags } from './trialForumTags.js';
```

In `getOrCreateTrialForum`, change the final `return forum;` so the forum always has the four tags before any thread is created:

```ts
  const forum = await getOrCreateChannel(guild, {
    name: 'trial-reviews',
    type: ChannelType.GuildForum,
    categoryName: 'Overlords',
    configKey: 'trial_reviews_forum_id',
  });

  return ensureTrialForumTags(forum);
```

Then in `createTrialReviewThread`, after `const forum = await getOrCreateTrialForum(client);`, resolve the Active tag, and add `appliedTags` to the `forum.threads.create({...})` call:

```ts
  // Create forum thread
  const forum = await getOrCreateTrialForum(client);
  const activeTag = forum.availableTags.find((t) => t.name === 'Active');
```

```ts
  const thread = await forum.threads.create({
    name: characterName,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
    appliedTags: activeTag ? [activeTag.id] : [],
    message: {
      content: reviewContent,
      components: [buttonRow],
    },
  });
```

- [ ] **Step 2: `markForPromotion.ts` — apply "To Be Promoted" before archiving**

Add the import:

```ts
import { applyTrialTag } from './trialForumTags.js';
```

In the `try` block, the thread is un-archived by the existing `thread.send(...)`; apply the tag immediately after the send and **before** `closeThread(thread)`:

```ts
    await thread.send(
      `**Marked for Promotion**\n` +
      `**${trial.character_name}** has been marked for promotion.\n` +
      `A promotion reminder will be sent on **${promoteDateStr}**.`,
    );

    // Update the forum tag while the thread is un-archived (the send above
    // un-archives it), before closeThread locks/archives it again.
    await applyTrialTag(thread, 'To Be Promoted');

    // Close the thread (lock + archive). The next-day promotion reminder posts
    // back into the thread, which will auto-unarchive it; it stays locked.
    await closeThread(thread);
```

- [ ] **Step 3: `closeTrial.ts` — apply Promoted or Failed based on the pre-close status**

Add the import:

```ts
import { applyTrialTag } from './trialForumTags.js';
```

`closeTrial` already reads the `trial` row (with its status) before it runs `UPDATE trials SET status = 'closed'`. Use that pre-close status to pick the outcome tag. Compute it once near the top of the archival block, then apply it after the existing `thread.send(...)` and before `closeThread(thread)`:

```ts
  // Archive the thread
  if (trial.thread_id) {
    try {
      const guild = client.guilds.cache.first();
      if (!guild) return;

      const thread = (await guild.channels.fetch(trial.thread_id)) as ThreadChannel | null;
      if (thread?.isThread()) {
        await thread.send(
          `**Trial Closed**\nThe trial for **${trial.character_name}** has been closed.`,
        );

        // A trial closed from the 'promoted' (To Be Promoted) state succeeded;
        // anything else (still 'active') is a failed trial. `trial.status` here
        // is the value read before the UPDATE above, i.e. the pre-close status.
        const outcomeTag = trial.status === 'promoted' ? 'Promoted' : 'Failed';
        await applyTrialTag(thread, outcomeTag);

        // Close the thread (lock + archive) after the closing message lands.
        await closeThread(thread);
      }
    } catch (error) {
```

- [ ] **Step 4: Verify no regressions**

Run: `npx vitest run --project default && npx tsc --noEmit`
Expected: all unit+integration tests PASS (same count as before this task), no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/functions/trial-review/createTrialReviewThread.ts src/functions/trial-review/markForPromotion.ts src/functions/trial-review/closeTrial.ts
git commit -m "feat(trials): apply status tags across the trial lifecycle"
```

---

### Task 3: Full-suite verification + manual end-to-end note

**Files:** none (verification only).

- [ ] **Step 1: Run the full unit/integration suite and typecheck**

Run: `npx vitest run --project default && npx tsc --noEmit`
Expected: all tests PASS, no type errors.

- [ ] **Step 2: Manual end-to-end verification (test server)**

The lifecycle wiring (Discord forum + threads) isn't unit-tested end to end. On the **test server** (develop deploy):
1. `/trials create_thread` → confirm the new thread carries the **Active** tag, and that the trial-reviews forum now lists all four tags (Active / To Be Promoted / Promoted / Failed).
2. Click **Mark for Promotion** → confirm the thread's tag becomes **To Be Promoted**.
3. Close that trial (e.g. `/trials remove_trial` with its thread id, or the Close button) → confirm the tag becomes **Promoted** (because it was To Be Promoted).
4. Create a second trial and close it directly (without marking for promotion) → confirm the tag becomes **Failed**.
5. Confirm existing (pre-feature) trials are untouched until they next transition.

- [ ] **Step 3: No commit** (verification only).

---

## Self-Review

- **Spec coverage:** four tag names (Global Constraints + Task 1 `TRIAL_TAG_NAMES`); `ensureTrialForumTags` additive seeding + refetch (Task 1); `applyTrialTag` single-tag replace with graceful no-op (Task 1); Active on create (Task 2 Step 1); To Be Promoted on mark (Task 2 Step 2); Promoted/Failed inferred from pre-close status on close (Task 2 Step 3); apply-after-send-before-closeThread ordering (Global Constraints + Task 2 Steps 2–3); new-trials-only / no backfill (no code touches existing threads); testing at the helper layer (Task 1) + manual e2e (Task 3). All spec sections map to a task.
- **Placeholder scan:** none — every code step shows the exact edit.
- **Type consistency:** `ensureTrialForumTags(forum): Promise<ForumChannel>` and `applyTrialTag(thread, tagName): Promise<void>` defined in Task 1 and consumed unchanged in Task 2; tag-name string literals (`'Active'`, `'To Be Promoted'`, `'Promoted'`, `'Failed'`) are identical across the helper, the create path, and the transitions.

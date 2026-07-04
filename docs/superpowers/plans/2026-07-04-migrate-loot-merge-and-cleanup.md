# /migrate Loot Vote Merge + Loot Cleanup Command — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `/migrate` so it imports V1 loot votes onto loot posts that already exist (instead of skipping them entirely), and add a `/loot delete_all_posts` command that wipes every loot post (Discord messages + DB rows).

**Architecture:** `recreateLootPosts` currently has one branch that both skips duplicate post creation AND skips vote import when a `boss_id` already exists. Split those concerns: always import votes (idempotent `INSERT OR IGNORE`) and re-render; only skip the *Discord post creation* when the post already exists. Add a thin `deleteAllLootPosts` that reuses the existing `deleteLootPost` for every row, wired to a new `/loot delete_all_posts` subcommand.

**Tech Stack:** TypeScript (ESM, Node16 — local imports use `.js`), discord.js v14, better-sqlite3, vitest.

**Background:** On the test server, the current tier's loot posts already existed (created by the normal `/loot create_posts` flow, which uses the same WoW journal `boss_id`s: 197132–197140). `/migrate`'s skip-existing guard therefore skipped all 9 and imported zero votes. This plan makes vote import independent of whether the post pre-exists.

## Global Constraints

- ESM with Node16 resolution: **all local imports use the `.js` extension**.
- `/loot` subcommands use `MessageFlags.Ephemeral`, `requireOfficer(interaction)`, `Administrator` default perms (match existing subcommands in `src/commands/loot.ts`).
- Vote import must stay idempotent: `insertLootResponses` uses `INSERT OR IGNORE`, so re-running merges the same votes with no duplicates.
- Reuse the existing `deleteLootPost` (`src/functions/loot/deleteLootPost.ts`) — it already deletes the Discord message, then `loot_responses`, then the `loot_posts` row for one boss.

---

### Task 1: `recreateLootPosts` imports votes into existing posts (merge, don't skip)

**Files:**
- Modify: `src/functions/migrate/recreateLootPosts.ts`
- Modify: `src/commands/migrate.ts` (summary line wording)
- Test: `tests/unit/migrate/recreateLootPosts.test.ts`

**Interfaces:**
- Produces (changed): `export interface LootRecreateResult { created: number; merged: number; failed: number }` — `created` = posts newly created, `merged` = votes imported into a pre-existing post, `failed` = per-post errors.

- [ ] **Step 1: Update the tests to express the new behaviour (write them first, watch them fail)**

Replace the current `recreateLootPosts` describe block (the "skips a boss already present" test) with these, and update the failure-isolation expectation. The `insertLootResponses` describe block stays unchanged.

```ts
describe('recreateLootPosts', () => {
  it('creates a post + responses on first run, then merges votes into the existing post on re-run', async () => {
    const client = { guilds: { fetch: vi.fn(async () => ({ id: 'guild-1' })) } } as never;

    const first = await recreateLootPosts(client, [post]);
    expect(first).toEqual({ created: 1, merged: 0, failed: 0 });
    expect(getDatabase().prepare('SELECT COUNT(*) c FROM loot_responses').get()).toEqual({ c: 4 });

    // Re-run: post already exists → votes merged, no new post, INSERT OR IGNORE keeps count at 4.
    const second = await recreateLootPosts(client, [post]);
    expect(second).toEqual({ created: 0, merged: 1, failed: 0 });
    expect(getDatabase().prepare('SELECT COUNT(*) c FROM loot_responses').get()).toEqual({ c: 4 });
  });

  it('merges votes into a post that already existed (e.g. created by /loot create_posts) without creating a duplicate', async () => {
    const client = { guilds: { fetch: vi.fn(async () => ({ id: 'guild-1' })) } } as never;
    const { addLootPost } = await import('../../../src/functions/loot/addLootPost.js');

    // Simulate a pre-existing post created by the normal loot flow.
    getDatabase()
      .prepare('INSERT INTO loot_posts (boss_id, boss_name, boss_url, channel_id, message_id) VALUES (?, ?, ?, ?, ?)')
      .run(post.bossId, post.bossName, post.bossUrl, 'preexisting-chan', 'preexisting-msg');

    const result = await recreateLootPosts(client, [post]);

    expect(result).toEqual({ created: 0, merged: 1, failed: 0 });
    expect(vi.mocked(addLootPost)).not.toHaveBeenCalled();      // no duplicate post
    expect(getDatabase().prepare('SELECT COUNT(*) c FROM loot_responses').get()).toEqual({ c: 4 });
    // votes attached to the pre-existing post, not a new one
    const only = getDatabase().prepare('SELECT COUNT(*) c FROM loot_posts WHERE boss_id = ?').get(post.bossId);
    expect(only).toEqual({ c: 1 });
  });

  it('isolates a per-post failure and still processes the rest', async () => {
    const client = { guilds: { fetch: vi.fn(async () => ({ id: 'guild-1' })) } } as never;
    const { addLootPost } = await import('../../../src/functions/loot/addLootPost.js');
    vi.mocked(addLootPost).mockRejectedValueOnce(new Error('discord fail'));

    const postB = { ...post, bossId: 197139, bossName: 'Belo’ren, Child of Al’ar' };
    const result = await recreateLootPosts(client, [post, postB]);

    expect(result).toEqual({ created: 1, merged: 0, failed: 1 });
    // the boss that failed created no loot_posts row
    expect(getDatabase().prepare('SELECT COUNT(*) c FROM loot_posts WHERE boss_id = ?').get(post.bossId)).toEqual({ c: 0 });
  });
});
```

Note: the existing `addLootPost` mock (top of file) inserts the `loot_posts` row into the in-memory DB when called; `vi.clearAllMocks()` in the describe's `beforeEach` resets call counts without wiping that factory implementation. Keep those as-is.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/migrate/recreateLootPosts.test.ts`
Expected: FAIL — the current code returns `skipped` (not `merged`) and skips vote import for existing posts, so the merge assertions and `LootRecreateResult` shape won't match.

- [ ] **Step 3: Update `recreateLootPosts.ts`**

Change the result interface and the loop so vote import always runs; only post *creation* is conditional.

Replace the interface:

```ts
export interface LootRecreateResult { created: number; merged: number; failed: number }
```

Replace the `result` initialisation and the channel-failure early return to use `merged` instead of `skipped`:

```ts
  const result: LootRecreateResult = { created: 0, merged: 0, failed: 0 };
```

```ts
  } catch (error) {
    logger.error('Migrate', 'Failed to resolve loot channel', error as Error);
    return { created: 0, merged: 0, failed: lootPosts.length };
  }
```

Remove the now-unused `stmtExists` and rewrite the loop (keep `stmtFetch`):

```ts
  const stmtFetch = db.prepare('SELECT * FROM loot_posts WHERE boss_id = ?');

  for (const post of lootPosts) {
    try {
      let row = stmtFetch.get(post.bossId) as LootPostRow | undefined;
      const alreadyExisted = row !== undefined;

      if (!row) {
        await addLootPost(channel, { id: post.bossId, name: post.bossName, url: post.bossUrl ?? undefined });
        row = stmtFetch.get(post.bossId) as LootPostRow | undefined;
        if (!row) throw new Error(`loot_posts row missing after addLootPost for boss ${post.bossId}`);
      }

      insertLootResponses(db, row.id, post.votes);
      await updateLootPost(client, post.bossId);

      if (alreadyExisted) result.merged++;
      else result.created++;
    } catch (error) {
      result.failed++;
      logger.error('Migrate', `Failed to recreate loot post for boss ${post.bossId}`, error as Error);
    }
  }

  return result;
```

- [ ] **Step 4: Update the `/migrate` summary line**

In `src/commands/migrate.ts`, replace the loot summary line:

```ts
        `• Loot posts: ${loot.created} created, ${loot.skipped} skipped, ${loot.failed} failed\n` +
```

with:

```ts
        `• Loot posts: ${loot.created} created, ${loot.merged} merged into existing, ${loot.failed} failed\n` +
```

- [ ] **Step 5: Run the tests + typecheck**

Run: `npx vitest run tests/unit/migrate/recreateLootPosts.test.ts && npx tsc --noEmit`
Expected: PASS (insertLootResponses + 3 recreateLootPosts tests), no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/functions/migrate/recreateLootPosts.ts src/commands/migrate.ts tests/unit/migrate/recreateLootPosts.test.ts
git commit -m "fix(migrate): import loot votes into existing posts instead of skipping"
```

---

### Task 2: `deleteAllLootPosts` + `/loot delete_all_posts` subcommand

**Files:**
- Create: `src/functions/loot/deleteAllLootPosts.ts`
- Modify: `src/commands/loot.ts`
- Test: `tests/unit/loot/deleteAllLootPosts.test.ts`

**Interfaces:**
- Consumes: `deleteLootPost` (`src/functions/loot/deleteLootPost.js`), `getDatabase` (`src/database/db.js`).
- Produces: `export async function deleteAllLootPosts(client: Client): Promise<number>` — deletes every loot post (message + rows), returns the count deleted.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/loot/deleteAllLootPosts.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTables } from '../../../src/database/schema.js';

vi.mock('../../../src/functions/loot/deleteLootPost.js', () => ({ deleteLootPost: vi.fn(async () => {}) }));

import { getDatabase, closeDatabase } from '../../../src/database/db.js';
import { deleteLootPost } from '../../../src/functions/loot/deleteLootPost.js';
import { deleteAllLootPosts } from '../../../src/functions/loot/deleteAllLootPosts.js';

beforeEach(() => {
  closeDatabase();
  createTables(getDatabase(':memory:'));
  vi.clearAllMocks();
});

describe('deleteAllLootPosts', () => {
  it('calls deleteLootPost for every loot post and returns the count', async () => {
    const db = getDatabase();
    const insert = db.prepare('INSERT INTO loot_posts (boss_id, boss_name, boss_url, channel_id, message_id) VALUES (?, ?, ?, ?, ?)');
    insert.run(101, 'A', null, 'c', 'm1');
    insert.run(202, 'B', null, 'c', 'm2');

    const client = {} as never;
    const count = await deleteAllLootPosts(client);

    expect(count).toBe(2);
    expect(vi.mocked(deleteLootPost)).toHaveBeenCalledTimes(2);
    const calledBossIds = vi.mocked(deleteLootPost).mock.calls.map((c) => c[1]).sort();
    expect(calledBossIds).toEqual([101, 202]);
  });

  it('returns 0 and calls nothing when there are no loot posts', async () => {
    const count = await deleteAllLootPosts({} as never);
    expect(count).toBe(0);
    expect(vi.mocked(deleteLootPost)).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/loot/deleteAllLootPosts.test.ts`
Expected: FAIL — cannot find module `deleteAllLootPosts.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/functions/loot/deleteAllLootPosts.ts
import type { Client } from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';
import { deleteLootPost } from './deleteLootPost.js';

/**
 * Delete every loot post — Discord message and DB rows — by delegating to
 * deleteLootPost for each boss. Returns the number of posts deleted.
 */
export async function deleteAllLootPosts(client: Client): Promise<number> {
  const db = getDatabase();
  const rows = db.prepare('SELECT boss_id FROM loot_posts ORDER BY boss_id').all() as { boss_id: number }[];

  for (const { boss_id } of rows) {
    await deleteLootPost(client, boss_id);
  }

  logger.info('Loot', `Deleted all loot posts (${rows.length})`);
  return rows.length;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/loot/deleteAllLootPosts.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire the `/loot delete_all_posts` subcommand**

In `src/commands/loot.ts`, add the import alongside the other loot function imports:

```ts
import { deleteAllLootPosts } from '../functions/loot/deleteAllLootPosts.js';
```

Add the subcommand to the builder (after the existing `delete_posts` subcommand):

```ts
    .addSubcommand((sub) =>
      sub
        .setName('delete_all_posts')
        .setDescription('Delete ALL loot posts (Discord messages + database rows)'),
    ),
```

Add the case to the `switch (subcommand)` block (after the `delete_posts` case):

```ts
      case 'delete_all_posts': {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
          const count = await deleteAllLootPosts(interaction.client);
          await interaction.editReply({ content: `Deleted ${count} loot post${count === 1 ? '' : 's'}.` });
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          await interaction.editReply({ content: `Failed to delete loot posts: ${err.message}` });
        }
        break;
      }
```

- [ ] **Step 6: Run loot tests + typecheck**

Run: `npx vitest run tests/unit/loot tests/unit/loot.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/functions/loot/deleteAllLootPosts.ts src/commands/loot.ts tests/unit/loot/deleteAllLootPosts.test.ts
git commit -m "feat(loot): add /loot delete_all_posts to wipe all loot posts"
```

---

### Task 3: Docs sync + full-suite verification + manual e2e note

**Files:**
- Modify: `docs/superpowers/specs/2026-07-04-migrate-v1-data-design.md`
- Modify: `docs/commands.md` (document the new subcommand)

- [ ] **Step 1: Update the migrate spec's loot-layer description**

In `docs/superpowers/specs/2026-07-04-migrate-v1-data-design.md`, find the `recreateLootPosts` bullet that says it skips bosses whose `boss_id` already exists, and replace that wording so it reflects the new behaviour: it creates the Discord post only when one doesn't already exist, but **always imports the votes** (`INSERT OR IGNORE`) and re-renders — so votes land whether or not the post was created by the normal `/loot create_posts` flow. Result counters are `created` / `merged` / `failed`.

- [ ] **Step 2: Document the new command**

In `docs/commands.md`, under the `/loot` section, add a line for the `delete_all_posts` subcommand: deletes all loot posts (Discord messages + DB rows). Admin only.

- [ ] **Step 3: Full-suite verification**

Run: `npx vitest run --project default && npx tsc --noEmit`
Expected: all unit+integration tests PASS, no type errors.

- [ ] **Step 4: Manual end-to-end (test server), after deploy**

1. Re-run `/migrate` with the V1 `db.sqlite`. The summary should now show the 9 loot posts as **merged into existing** (not skipped), and the posts should display the imported votes (unlinked voters as `<@id>` mentions).
2. Verify `loot_responses` is now populated (well above the previous 2).
3. Try `/loot delete_all_posts` → confirm the loot channel messages are removed and `loot_posts` / `loot_responses` are emptied.

- [ ] **Step 5: Commit the docs**

```bash
git add docs/superpowers/specs/2026-07-04-migrate-v1-data-design.md docs/commands.md
git commit -m "docs: reflect loot vote merge and /loot delete_all_posts"
```

---

## Self-Review

- **Coverage:** merge-not-skip behaviour (Task 1, with a regression test for a pre-existing post + a re-run idempotency test); summary wording (Task 1 Step 4); failure isolation preserved (Task 1 test); cleanup command with function + subcommand + tests (Task 2); docs + full verification + manual e2e (Task 3).
- **Placeholder scan:** none — all edits shown in full.
- **Type consistency:** `LootRecreateResult` becomes `{ created, merged, failed }` in Task 1 and the `/migrate` summary reads `loot.merged` accordingly; `deleteAllLootPosts(client): Promise<number>` defined in Task 2 and consumed by the command in the same task.

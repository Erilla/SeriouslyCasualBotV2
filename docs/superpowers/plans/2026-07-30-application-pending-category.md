# Pending Application Category Count Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display the active submitted-application count in the category that contains the `application-log` forum.

**Architecture:** A new `applicationLogCategory` helper owns category discovery, the active-only database count, and best-effort Discord renaming. It stores the category ID under its own config key so the category remains discoverable after its name changes. Application submission, accept/reject decisions, and startup call the helper only after their relevant database state is current.

**Tech Stack:** TypeScript (ESM), discord.js v14, better-sqlite3, Vitest.

## Global Constraints

- Display name must be exactly `APPLICATION LOGS · <N> PENDING`.
- `<N>` counts only `applications.status = 'active'`.
- Use config key `application_log_category_id`; do not reuse `applications_category_id`.
- Category refresh must be best-effort and must never fail application submission, acceptance, rejection, or startup.
- Do not create a new category when an application-log category cannot be resolved.

---

## File Structure

- Create `src/functions/applications/applicationLogCategory.ts` — resolves the existing application-log category, builds the count label, and refreshes it.
- Create `tests/unit/applicationLogCategory.test.ts` — isolates category discovery, count semantics, rename idempotency, and failure handling.
- Modify `src/functions/applications/createForumPost.ts` — uses the category resolver as the forum parent instead of a static category name.
- Modify `src/functions/applications/submitApplication.ts` — refreshes the category after marking an application active.
- Modify `src/functions/applications/acceptApplication.ts` — refreshes the category after marking an application accepted.
- Modify `src/functions/applications/rejectApplication.ts` — refreshes the category after marking an application rejected.
- Modify `src/events/ready.ts` — refreshes the category once the guild bootstrap completes.

### Task 1: Application-log category helper

**Files:**
- Create: `src/functions/applications/applicationLogCategory.ts`
- Create: `tests/unit/applicationLogCategory.test.ts`

**Interfaces:**
- Consumes: `getDatabase(): Database.Database`, `Guild`, `CategoryChannel`, and the existing logger service.
- Produces: `buildPendingApplicationCategoryName(count: number): string`, `resolveApplicationLogCategory(guild: Guild): Promise<CategoryChannel | null>`, and `refreshPendingApplicationCategory(guild: Guild): Promise<void>`.

- [ ] **Step 1: Write the failing helper tests**

```ts
it('uses the stored category ID and counts only active applications', async () => {
  seedConfig('application_log_category_id', 'category-1');
  seedApplication('active');
  seedApplication('active');
  seedApplication('in_progress');
  seedApplication('accepted');
  const category = makeCategory({ id: 'category-1', name: 'Application-logs' });

  await refreshPendingApplicationCategory(makeGuild([category]));

  expect(category.setName).toHaveBeenCalledWith('APPLICATION LOGS · 2 PENDING');
});

it('discovers and persists the legacy-named category when no ID is stored', async () => {
  const category = makeCategory({ id: 'category-1', name: 'Application-logs' });

  await expect(resolveApplicationLogCategory(makeGuild([category]))).resolves.toBe(category);

  expect(readConfig('application_log_category_id')).toBe('category-1');
});

it('does not rename a category that already displays the current count', async () => {
  const category = makeCategory({ id: 'category-1', name: 'APPLICATION LOGS · 0 PENDING' });
  seedConfig('application_log_category_id', 'category-1');

  await refreshPendingApplicationCategory(makeGuild([category]));

  expect(category.setName).not.toHaveBeenCalled();
});

it('warns and resolves when the category cannot be found or Discord rejects the rename', async () => {
  await expect(refreshPendingApplicationCategory(makeGuild([]))).resolves.toBeUndefined();

  const category = makeCategory({ id: 'category-1', name: 'Application-logs' });
  category.setName.mockRejectedValueOnce(new Error('Missing Permissions'));
  await expect(refreshPendingApplicationCategory(makeGuild([category]))).resolves.toBeUndefined();
  expect(logger.warn).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `npm test -- tests/unit/applicationLogCategory.test.ts`

Expected: FAIL because `applicationLogCategory.ts` does not exist.

- [ ] **Step 3: Write the minimal helper implementation**

```ts
export const APPLICATION_LOG_CATEGORY_CONFIG_KEY = 'application_log_category_id';

export function buildPendingApplicationCategoryName(count: number): string {
  return `APPLICATION LOGS · \${count} PENDING`;
}

export async function refreshPendingApplicationCategory(guild: Guild): Promise<void> {
  try {
    const category = await resolveApplicationLogCategory(guild);
    if (!category) return;
    const row = getDatabase()
      .prepare("SELECT COUNT(*) AS count FROM applications WHERE status = 'active'")
      .get() as { count: number };
    const name = buildPendingApplicationCategoryName(row.count);
    if (category.name !== name) await category.setName(name);
  } catch (error) {
    logger.warn('Applications', `Failed to refresh pending application category: \${String(error)}`);
  }
}
```

Implement `resolveApplicationLogCategory` to prefer the stored ID (cache first, then `guild.channels.fetch(id)`), validate `ChannelType.GuildCategory`, and delete a stale or wrong-type config value. If no valid ID exists, scan the guild cache for either `Application-logs` or a current `APPLICATION LOGS · <N> PENDING` label, save its ID with `INSERT OR REPLACE`, and return it. Return `null` after a warning when neither lookup succeeds; never call `guild.channels.create`.

- [ ] **Step 4: Run the helper tests to verify they pass**

Run: `npm test -- tests/unit/applicationLogCategory.test.ts`

Expected: PASS with active-only count, persisted discovery, idempotent naming, and non-throwing failures covered.

- [ ] **Step 5: Commit the helper**

```bash
git add src/functions/applications/applicationLogCategory.ts tests/unit/applicationLogCategory.test.ts
git commit -m "feat(applications): show pending count in category"
```

### Task 2: Use the helper at every state boundary

**Files:**
- Modify: `src/functions/applications/createForumPost.ts`
- Modify: `src/functions/applications/submitApplication.ts`
- Modify: `src/functions/applications/acceptApplication.ts`
- Modify: `src/functions/applications/rejectApplication.ts`
- Modify: `src/events/ready.ts`
- Modify: `tests/unit/applicationLogCategory.test.ts`

**Interfaces:**
- Consumes: `resolveApplicationLogCategory(guild)` and `refreshPendingApplicationCategory(guild)` from `applicationLogCategory.ts`.
- Produces: forums whose parent is the resolved application-log category and category counts refreshed after all active-status transitions and startup.

- [ ] **Step 1: Write the failing lifecycle wiring tests**

```ts
it('uses the resolved category as the application-log forum parent', async () => {
  mockedResolveApplicationLogCategory.mockResolvedValue(makeCategory({ id: 'category-1' }));

  await createForumPost(guild, 'TestCharacter', applicant, 'answers', 1);

  expect(mockedGetOrCreateChannel).toHaveBeenCalledWith(
    guild,
    expect.objectContaining({ categoryName: null, createOptions: { parent: 'category-1' } }),
  );
});

it('refreshes after the active, accepted, and rejected database updates', async () => {
  await submitApplication(client, applicationId, applicant);
  await processAcceptModal(acceptInteraction);
  await processRejectModal(rejectInteraction);

  expect(mockedRefreshPendingApplicationCategory).toHaveBeenCalledTimes(3);
});
```

Put the first assertion in a focused `createForumPost` unit test, mocking `getOrCreateChannel` and `resolveApplicationLogCategory`. Put each lifecycle assertion in focused tests that mock forum creation, DMs, transcript generation, and trial creation so execution reaches the post-`UPDATE` calls. In a ready-event unit test, mock `refreshPendingApplicationCategory` and assert it receives the fetched guild once bootstrap completes.

- [ ] **Step 2: Run the affected tests to verify they fail**

Run: `npm test -- tests/unit/applicationLogCategory.test.ts tests/unit/applicationChannelOverwrites.test.ts`

Expected: FAIL because the application lifecycle modules and ready handler do not call the new helper yet.

- [ ] **Step 3: Wire the helper into forum placement and status transitions**

```ts
// createForumPost.ts
const category = await resolveApplicationLogCategory(guild);
forum = await getOrCreateChannel(guild, {
  name: 'application-log',
  type: ChannelType.GuildForum,
  categoryName: null,
  configKey: 'application_log_forum_id',
  createOptions: category ? { parent: category.id } : undefined,
});

// after each successful status UPDATE and after ready bootstrap
await refreshPendingApplicationCategory(guild);
```

Import the refresh helper in `submitApplication.ts`, `acceptApplication.ts`, and `rejectApplication.ts` immediately after each corresponding database update. Import it in `ready.ts` and call it inside the existing `if (guild)` bootstrap block through `tryBootstrap('application pending count', ...)`, so startup remains best-effort. The helper absorbs its own failure; the startup wrapper keeps the existing startup logging pattern.

- [ ] **Step 4: Run focused tests and static checks**

Run: `npm test -- tests/unit/applicationLogCategory.test.ts tests/unit/applicationChannelOverwrites.test.ts && npm run typecheck && npm run lint`

Expected: all commands exit 0.

- [ ] **Step 5: Run the application regression suite**

Run: `npm test -- tests/unit/applicationChannelOverwrites.test.ts && npm run test:integration -- tests/integration/applications-flow.test.ts`

Expected: all application-channel and database-flow tests exit 0.

- [ ] **Step 6: Commit the lifecycle wiring**

```bash
git add src/functions/applications/createForumPost.ts src/functions/applications/submitApplication.ts src/functions/applications/acceptApplication.ts src/functions/applications/rejectApplication.ts src/events/ready.ts tests/unit/applicationLogCategory.test.ts
git commit -m "feat(applications): refresh pending category count"
```




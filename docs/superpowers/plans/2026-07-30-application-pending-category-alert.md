# Pending Application Category Alert Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prefix the category title with a red square whenever at least one active application is pending.

**Architecture:** Keep all lifecycle behavior in the existing `applicationLogCategory` helper. Its name-builder will add the red-square prefix only for positive counts, and the resolver’s dynamic-name pattern will accept both the previous and new display forms.

**Tech Stack:** TypeScript (ESM), discord.js v14, better-sqlite3, Vitest.

## Global Constraints

- For `count > 0`, the title must be exactly `🟥 APPLICATION LOGS · <N> PENDING`.
- For `count === 0`, the title must be exactly `APPLICATION LOGS · 0 PENDING`.
- The count remains limited to `applications.status = 'active'`.
- Existing category resolution, its `application_log_category_id` setting, and all refresh lifecycle hooks remain unchanged.

---

## File Structure

- Modify `src/functions/applications/applicationLogCategory.ts` — formats the alert title and recognises it during category discovery.
- Modify `tests/unit/applicationLogCategory.test.ts` — asserts title output, idempotency, and discovery for both alert states.

### Task 1: Conditional category alert title

**Files:**
- Modify: `src/functions/applications/applicationLogCategory.ts:7-12,38-41`
- Modify: `tests/unit/applicationLogCategory.test.ts:191-238`

**Interfaces:**
- Consumes: `buildPendingApplicationCategoryName(count: number): string` and `resolveApplicationLogCategory(guild: Guild): Promise<CategoryChannel | null>`.
- Produces: the same interfaces, with red-square formatting for positive counts and resolver support for both dynamic formats.

- [x] **Step 1: Write failing title and discovery assertions**

```ts
expect(buildPendingApplicationCategoryName(0)).toBe('APPLICATION LOGS · 0 PENDING');
expect(buildPendingApplicationCategoryName(2)).toBe('🟥 APPLICATION LOGS · 2 PENDING');

const category = makeCategory({ id: 'category-2', name: '🟥 APPLICATION LOGS · 3 PENDING' });
await expect(resolveApplicationLogCategory(makeGuild([category]))).resolves.toBe(category);
```

Update the active-count refresh assertion to expect `🟥 APPLICATION LOGS · 2 PENDING`. Keep the zero-count idempotency assertion unprefixed and add an idempotency assertion for `🟥 APPLICATION LOGS · 1 PENDING` with one seeded active row.

- [x] **Step 2: Run the focused test to verify it fails**

Run: `npm test -- tests/unit/applicationLogCategory.test.ts`

Expected: FAIL because the current builder emits an unprefixed positive-count title and the resolver does not recognise the red-square format.

- [x] **Step 3: Implement the conditional title and resolver pattern**

```ts
const CURRENT_CATEGORY_NAME = /^(?:🟥 )?APPLICATION LOGS · \d+ PENDING$/;

export function buildPendingApplicationCategoryName(count: number): string {
  const prefix = count > 0 ? '🟥 ' : '';
  return `\${prefix}APPLICATION LOGS · \${count} PENDING`;
}
```

Do not change the active-count SQL query, category config key, resolver persistence behavior, or refresh call sites.

- [x] **Step 4: Run focused and project checks**

Run: `npm test -- tests/unit/applicationLogCategory.test.ts && npm run typecheck && npm run lint`

Expected: all commands exit 0.

- [x] **Step 5: Commit the implementation and plan**

```bash
git add src/functions/applications/applicationLogCategory.ts tests/unit/applicationLogCategory.test.ts docs/superpowers/plans/2026-07-30-application-pending-category-alert.md
git commit -m "feat(applications): highlight pending category"
```



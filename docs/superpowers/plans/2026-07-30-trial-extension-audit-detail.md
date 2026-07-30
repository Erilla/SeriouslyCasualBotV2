# Trial Extension Audit Detail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make successful trial-extension audits identify the Discord review thread and record the resulting six-week review date, without exposing an internal trial ID.

**Architecture:** Keep audit rendering in `auditRefs.ts`: `trialRef` becomes a Discord-facing character/thread reference with no database ID. The trial extension handler queries the persisted `6_week` alert only after `extendTrial` completes and appends that date using `dateRef`, which produces a viewer-local Discord timestamp.

**Tech Stack:** TypeScript, discord.js, better-sqlite3, Vitest.

## Global Constraints

- Do not add an `end_date` database field; a trial's effective end is its persisted `6_week` `trial_alerts` date.
- Keep extension error handling and the ephemeral success reply unchanged.
- Preserve the `#<id>` audit fallback only when the trial cannot be read.
- Normal trial audit references must not include internal trial IDs.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/services/auditRefs.ts` | Render a human-facing trial reference without internal database IDs. |
| `src/interactions/trial.ts` | Query the updated six-week alert after an extension and append it to the audit entry. |
| `tests/unit/auditRefs.test.ts` | Protect the reference formatting contract. |
| `tests/unit/interactions/trial.test.ts` | Protect the extension handler's enriched audit behaviour. |

### Task 1: Render trial references without database IDs

**Files:**
- Modify: `src/services/auditRefs.ts:3-7`
- Modify: `tests/unit/auditRefs.test.ts:4-17`

**Interfaces:**
- Consumes: `Pick<TrialRow, 'character_name' | 'thread_id'>`.
- Produces: `trialRef(trial): string`, formatted as `**Name** — <#thread>` when a thread exists and `**Name**` otherwise.

- [ ] **Step 1: Write the failing tests**

Replace the two `trialRef` expectations with tests that call the helper using no `id` and assert:

```ts
expect(trialRef({ character_name: 'Sploboss', thread_id: '123' })).toBe(
  '**Sploboss** — <#123>',
);

expect(trialRef({ character_name: 'Sploboss', thread_id: null })).toBe('**Sploboss**');
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npx vitest run tests/unit/auditRefs.test.ts`

Expected: FAIL because `trialRef` still requires and renders `id`.

- [ ] **Step 3: Write the minimal implementation**

Replace the helper signature and body with:

```ts
/** `**Name**`, plus ` — <#thread_id>` when the review thread exists. */
export function trialRef(trial: Pick<TrialRow, 'character_name' | 'thread_id'>): string {
  const base = `**${trial.character_name}**`;
  return trial.thread_id ? `${base} — <#${trial.thread_id}>` : base;
}
```

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `npx vitest run tests/unit/auditRefs.test.ts`

Expected: PASS with all trial, application, and date reference tests green.

- [ ] **Step 5: Commit the isolated formatting change**

```powershell
git add -- src/services/auditRefs.ts tests/unit/auditRefs.test.ts
git commit -m "fix(audit): omit internal trial ids from references"
```

### Task 2: Audit the persisted post-extension review date

**Files:**
- Modify: `src/interactions/trial.ts:11-12, 68-81`
- Create: `tests/unit/interactions/trial.test.ts`

**Interfaces:**
- Consumes: `extendTrial(client, trialId)` and a `TrialAlertRow` selected by `trial_id` and `alert_name = '6_week'`.
- Produces: `audit(user, 'extended trial', '**Name** — <#thread>; ends <t:...:D>')` after a successful extension.

- [ ] **Step 1: Write the failing interaction test**

Create `tests/unit/interactions/trial.test.ts` with hoisted mocks for `getDatabase`, `audit`, and `extendTrial`; mock the remaining trial-action imports to no-op functions. Import `buttons`, locate the `trial:extend` handler, and invoke it with a minimal button interaction whose `deferReply` and `editReply` are spies.

Configure the database mock so its first `get()` returns:

```ts
{ id: 3, character_name: 'Binded', thread_id: '456' }
```

and the post-extension alert lookup returns:

```ts
{ alert_date: '2026-08-06' }
```

Assert the handler calls:

```ts
expect(audit).toHaveBeenCalledWith(
  interaction.user,
  'extended trial',
  '**Binded** — <#456>; ends <t:1785974400:D>',
);
expect(interaction.editReply).toHaveBeenCalledWith({ content: 'Trial extended by 1 week.' });
```

- [ ] **Step 2: Run the focused interaction test to verify it fails**

Run: `npx vitest run tests/unit/interactions/trial.test.ts`

Expected: FAIL because the handler currently audits the pre-extension trial reference and does not query or append the six-week alert date.

- [ ] **Step 3: Write the minimal extension audit implementation**

In `src/interactions/trial.ts`, import `dateRef` with `trialRef`:

```ts
import { dateRef, trialRef } from '../services/auditRefs.js';
```

Immediately after `await extendTrial(interaction.client, trialId);`, select the persisted six-week alert:

```ts
const endAlert = getDatabase()
  .prepare("SELECT alert_date FROM trial_alerts WHERE trial_id = ? AND alert_name = '6_week'")
  .get(trialId) as Pick<TrialAlertRow, 'alert_date'> | undefined;
const detail = trial
  ? `${trialRef(trial)}${endAlert ? `; ends ${dateRef(endAlert.alert_date)}` : ''}`
  : `#${trialId}`;
await audit(interaction.user, 'extended trial', detail);
```

Add `TrialAlertRow` to the existing type import:

```ts
import type { TrialAlertRow, TrialRow } from '../types/index.js';
```

- [ ] **Step 4: Run the focused interaction test to verify it passes**

Run: `npx vitest run tests/unit/interactions/trial.test.ts`

Expected: PASS; audit receives the character, review-thread mention, and localized resulting review date with no `#3` ID.

- [ ] **Step 5: Run the affected test suite and static checks**

Run:

```powershell
npx vitest run tests/unit/auditRefs.test.ts tests/unit/interactions/trial.test.ts
npm run typecheck
npm run lint
```

Expected: all commands exit 0.

- [ ] **Step 6: Commit the extension audit change**

```powershell
git add -- src/interactions/trial.ts tests/unit/interactions/trial.test.ts
git commit -m "fix(audit): include trial extension end date"
```

## Plan Self-Review

- Spec coverage: Task 1 removes normal internal trial IDs; Task 2 records the persisted post-extension six-week date and preserves the unavailable-trial fallback.
- Placeholder scan: no unresolved implementation steps or vague error-handling requirements remain.
- Type consistency: `TrialAlertRow.alert_date` is defined in `src/types/index.ts`; `dateRef` already accepts a `string`; `trialRef` accepts the fields available from `TrialRow`.

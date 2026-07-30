# Trial Review Extension Labels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Label extended final trial reviews with both their total duration and added extension duration.

**Architecture:** A small exported formatter in `createTrialReviewThread.ts` derives whole weeks between the initial start date and the persisted final review date. `buildReviewMessage` uses it for its final schedule line, so creation, extension, and trial-info updates all render the same correct wording.

**Tech Stack:** TypeScript, discord.js, Vitest.

## Global Constraints

- Do not add an `end_date` database field or an extension-count column.
- Continue using the persisted `6_week` `trial_alerts` date as the final review date.
- Keep the two-week and four-week review labels unchanged.
- At six weeks use `6-week review`; above six weeks use `<N>-week review (<N-6>-week extension)`.
- Existing extension scheduling, error handling, and timestamps must remain unchanged.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/functions/trial-review/createTrialReviewThread.ts` | Derive and render the final-review label. |
| `tests/unit/trialReviewMessage.test.ts` | Test initial, once-extended, and repeatedly-extended review-message output. |

### Task 1: Render dynamic final-review labels

**Files:**
- Modify: `src/functions/trial-review/createTrialReviewThread.ts:38-59`
- Create: `tests/unit/trialReviewMessage.test.ts`

**Interfaces:**
- Consumes: `startDate: string` and `sixWeek: Date`.
- Produces: `finalReviewLabel(startDate: string, sixWeek: Date): string`.
- Used by: `buildReviewMessage(characterName, role, startDate, twoWeek, fourWeek, sixWeek)`.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/trialReviewMessage.test.ts`. Import `buildReviewMessage` and use a shared helper:

```ts
function reviewMessage(sixWeekDate: string): string {
  return buildReviewMessage(
    'Binded',
    'DPS',
    '2026-01-01',
    new Date('2026-01-15T00:00:00Z'),
    new Date('2026-01-29T00:00:00Z'),
    new Date(`${sixWeekDate}T00:00:00Z`),
  );
}
```

Add three tests that assert the final review line is respectively:

```ts
expect(reviewMessage('2026-02-12')).toContain('6-week review:');
expect(reviewMessage('2026-02-19')).toContain('7-week review (1-week extension):');
expect(reviewMessage('2026-02-26')).toContain('8-week review (2-week extension):');
```

Also assert each message retains `2-week review:` and `4-week review:`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/trialReviewMessage.test.ts`

Expected: the seven- and eight-week expectations fail because the final line is hard-coded as `6-week review`.

- [ ] **Step 3: Implement the minimal formatter**

Above `buildReviewMessage`, add:

```ts
export function finalReviewLabel(startDate: string, finalReviewDate: Date): string {
  const start = new Date(`${startDate}T00:00:00Z`);
  const totalWeeks = Math.round((finalReviewDate.getTime() - start.getTime()) / (7 * 24 * 60 * 60 * 1000));
  const extensionWeeks = totalWeeks - 6;
  return extensionWeeks > 0
    ? `${totalWeeks}-week review (${extensionWeeks}-week extension)`
    : `${totalWeeks}-week review`;
}
```

In `buildReviewMessage`, calculate `const finalLabel = finalReviewLabel(startDate, sixWeek);` immediately after `startDateObj`, then replace the hard-coded final line with:

```ts
`  ${finalLabel}: ${toDiscordTimestamp(sixWeek)} (${toDiscordTimestamp(sixWeek, 'R')})`,
```

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `npx vitest run tests/unit/trialReviewMessage.test.ts`

Expected: all three duration cases pass, demonstrating the correct schedule text is used for initial and extended trials.

- [ ] **Step 5: Run affected and static verification**

Run:

```powershell
npx vitest run tests/unit/trialReviewMessage.test.ts tests/unit/trialAlerts.test.ts
npm run typecheck
npm run lint
```

Expected: all commands exit 0.

- [ ] **Step 6: Commit**

```powershell
git add -- src/functions/trial-review/createTrialReviewThread.ts tests/unit/trialReviewMessage.test.ts
git commit -m "fix(trials): label extended final reviews"
```

## Plan Self-Review

- Spec coverage: the final label reports both total weeks and extension weeks; it remains derived from existing persisted dates and leaves the earlier labels, scheduling, error paths, and timestamps unchanged.
- Placeholder scan: every test, command, function signature, and output string is defined.
- Type consistency: `buildReviewMessage` already receives `startDate: string` and `sixWeek: Date`, matching `finalReviewLabel`.


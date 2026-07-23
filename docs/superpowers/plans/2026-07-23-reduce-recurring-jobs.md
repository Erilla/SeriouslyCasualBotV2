# Reduce Recurring Jobs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace high-frequency polling with two daily maintenance jobs while retaining current reminders, reports, backups, and exact trial alert timers.

**Architecture:** A new `runDailyMaintenance(client)` orchestration function owns the roster sync, unlinked-raider alerts, linking-message repair, and trial-log refresh. It isolates failures and records status for each operation. `clientReady` schedules that function at 06:00, schedules achievements at 06:30, and keeps the three existing cron jobs unchanged.

**Tech Stack:** TypeScript ESM, Discord.js v14, Vitest, node-cron.

## Global Constraints

- Preserve the current task-status keys: `syncRaiders`, `refreshLinkingMessages`, `updateTrialLogs`, and `updateAchievements`.
- A failed maintenance operation must not prevent remaining operations from running.
- The daily maintenance job runs at `0 6 * * *`; achievements run at `30 6 * * *`.
- Preserve `alertSignups`, `weeklyReports`, `dailyBackup`, and database-backed trial timers unchanged.

---

### Task 1: Daily maintenance orchestration

**Files:**

- Create: `src/functions/maintenance/runDailyMaintenance.ts`
- Create: `tests/unit/runDailyMaintenance.test.ts`

**Interfaces:**

- Produces: `runDailyMaintenance(client: Client): Promise<void>`.
- Consumes: `syncRaiders`, `alertForNewUnlinkedRaiders`, `refreshLinkingMessages`, `updateTrialLogs`, and `recordTaskRun`.

- [ ] **Step 1: Write the failing test**

```ts
it('continues maintenance after a roster-sync failure and records each result', async () => {
  mockedSyncRaiders.mockRejectedValueOnce(new Error('Raider.IO unavailable'));

  await runDailyMaintenance(client);

  expect(mockedRefreshLinkingMessages).toHaveBeenCalledWith(client);
  expect(mockedUpdateTrialLogs).toHaveBeenCalledWith(client);
  expect(mockedRecordTaskRun).toHaveBeenCalledWith(
    'syncRaiders', false, 'Error: Raider.IO unavailable',
  );
  expect(mockedRecordTaskRun).toHaveBeenCalledWith('refreshLinkingMessages', true);
  expect(mockedRecordTaskRun).toHaveBeenCalledWith('updateTrialLogs', true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- runDailyMaintenance`

Expected: FAIL because `runDailyMaintenance.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
export async function runDailyMaintenance(client: Client): Promise<void> {
  await runTask('syncRaiders', async () => {
    const newUnlinked = await syncRaiders(client);
    await alertForNewUnlinkedRaiders(client, newUnlinked);
  });
  await runTask('refreshLinkingMessages', () => refreshLinkingMessages(client));
  await runTask('updateTrialLogs', () => updateTrialLogs(client));
}
```

Implement `runTask` in the same module: it catches errors, records `recordTaskRun(name, false, String(error))`, logs and returns; on success it records `recordTaskRun(name, true)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- runDailyMaintenance`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/functions/maintenance/runDailyMaintenance.ts tests/unit/runDailyMaintenance.test.ts
git commit -m "feat: add daily maintenance job"
```

### Task 2: Schedule the daily jobs

**Files:**

- Modify: `src/events/ready.ts`
- Modify: `src/commands/test.ts`
- Test: `tests/unit/runDailyMaintenance.test.ts`

**Interfaces:**

- Consumes: `runDailyMaintenance(client)` from Task 1.
- Produces: the scheduler registers five cron jobs and zero intervals at startup.

- [ ] **Step 1: Write the failing test**

Extend the orchestration test with a success case that asserts this order: roster sync, new-unlinked alert, link-message repair, trial-log refresh.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- runDailyMaintenance`

Expected: FAIL until Task 1's orchestration is implemented.

- [ ] **Step 3: Wire the new cron handlers**

Replace the `syncRaiders`, `refreshLinkingMessages`, and `updateTrialLogs` interval registrations in `src/events/ready.ts` with:

```ts
scheduler.registerCron({
  name: 'dailyMaintenance',
  expression: '0 6 * * *',
  handler: () => runDailyMaintenance(client),
});
```

Register `updateAchievements` at `30 6 * * *` and preserve its current `recordTaskRun` error boundary. Keep `alertSignups`, `weeklyReports`, and `dailyBackup` unchanged. In `src/commands/test.ts`, relabel the four manual actions as daily cron actions without changing their manual handlers.

- [ ] **Step 4: Run focused tests**

Run: `npm test -- runDailyMaintenance scheduler`

Expected: PASS.

- [ ] **Step 5: Run full verification**

Run: `npm run typecheck; npm run lint; npm run build; npm test`

Expected: every command exits 0. For the full default suite in this worktree, provide inert values for all required configuration variables rather than copying secrets into the worktree.

- [ ] **Step 6: Commit**

```bash
git add src/events/ready.ts src/commands/test.ts
git commit -m "refactor: run scheduled maintenance daily"
```


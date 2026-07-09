# Scheduler (node-cron)

Lightweight in-process scheduler. **No Redis, no BullMQ** — just `node-cron`
plus self-correcting `setTimeout` for interval jobs. There is a single
`Scheduler` instance for the whole bot.

## Files

- `src/scheduler/scheduler.ts` — the `Scheduler` class (interval + cron task
  lifecycle, per-task running-guard, error handling).
- `src/events/ready.ts` — the shared `scheduler` instance is created here and
  all jobs are registered inside the `clientReady` handler after startup.

## Registering a new job

Jobs are registered in `ready.ts` (not a separate `jobs.ts`). Add a
`scheduler.registerInterval(...)` or `scheduler.registerCron(...)` call before
`scheduler.start()`.

```ts
// Interval job — intervalMs is a wall-clock cadence (fires at :00, :10, :20 …):
scheduler.registerInterval({
  name: 'myJob',
  intervalMs: 5 * 60 * 1000,
  handler: async () => {
    await doSomething(client);
  },
});

// Cron job — standard 5-field cron expression:
scheduler.registerCron({
  name: 'myCronJob',
  expression: '0 12 * * 3', // noon on Wednesday
  handler: () => doSomethingElse(client),
});
```

Wrap the handler body in try/catch and call `recordTaskRun(name, ok, err?)`
(from `src/services/statusTracker.ts`) if the job should surface in `/status` —
see the existing interval jobs for the pattern.

## Key details

- **Interval alignment:** `registerInterval` uses a self-correcting
  `setTimeout` pinned to wall-clock boundaries (not `setInterval`), so a
  10-minute job fires at :00/:10/:20 regardless of bot start time or timer drift.
- **Running-guard:** if a task's previous run is still in flight when the next
  tick fires, that tick is skipped and logged at DEBUG — no overlapping runs.
- **Error isolation:** handler errors are caught and logged via
  `logger.error('scheduler', …)`; a failing job never crashes the loop or other
  jobs.
- **Lifecycle:** `scheduler.start()` is called once in `ready.ts`;
  `scheduler.shutdown()` is called from the `shutdown()` handler in
  `src/index.ts` (on SIGTERM/SIGINT), which clears all timers and stops all
  cron jobs.

## Current jobs (registered in `ready.ts`)

| Job | Type | Schedule | Handler |
|-----|------|----------|---------|
| syncRaiders | interval | every 10m | `syncRaiders` + `alertForNewUnlinkedRaiders` |
| refreshLinkingMessages | interval | every 10m | `refreshLinkingMessages` |
| updateAchievements | interval | every 30m | `updateAchievements` |
| updateTrialLogs | interval | every 60m | `updateTrialLogs` |
| alertSignups | cron | `0 19 * * 1,2,5,6` (7pm Mon/Tue/Fri/Sat) | `alertSignups` |
| weeklyReports | cron | `0 12 * * 3` (noon Wed) | `alertHighestMythicPlusDone` |
| dailyBackup | cron | `0 4 * * *` (4am daily) | `dailyBackup` |

Trial review/promotion alerts are **not** fixed jobs — they are scheduled
dynamically from the DB by `rescheduleAllAlerts` (called after
`scheduler.start()`), which computes per-trial timings.

# BullMQ Scheduler

## Files
- `src/scheduler/scheduler.ts` - Queue/Worker lifecycle, job registration, scheduling
- `src/scheduler/jobs.ts` - All job handler registrations and schedules

## Usage

### Registering a new job
In `jobs.ts`, add inside `registerAllJobs()`:
```ts
// 1. Register the handler
registerJob('myJobName', async (client) => {
    // client is the BotClient instance
    await doSomething(client);
});

// 2. Schedule it
// Interval (every N ms):
await scheduleRepeating('myJobName', '', { every: 5 * 60 * 1000 });

// Cron pattern:
await scheduleRepeating('myJobName', '0 12 * * 3'); // noon Wednesday
```

### Implementing a stub job
Many jobs in `jobs.ts` are stubs with `// TODO: Implement in Task X`. To implement:
1. Create the business logic function in `src/functions/`
2. Import it in `jobs.ts`
3. Replace the stub with the actual call

### Key details
- BullMQ uses Redis - configured via `REDIS_URL` env var
- Connection uses host/port/password config object (NOT ioredis instance - version mismatch)
- Worker concurrency is 1 (sequential job processing)
- Jobs have `removeOnComplete: { count: 5 }` and `removeOnFail: { count: 10 }`
- Scheduler initializes in `ready.ts` after Discord client is ready
- Graceful shutdown in `index.ts` calls `closeScheduler()`

## Current jobs (11)
| Job | Schedule | Task |
|-----|----------|------|
| checkApplications | every 5m | Task 5 |
| keepAppThreadsAlive | every 3m | Task 5 |
| updateAchievements | every 30m | Task 3 |
| updateTrialLogs | every 60m | Task 7 |
| keepTrialThreadsAlive | every 6m | Task 7 |
| checkReviewAlerts | every 3m | Task 7 |
| checkPromotionAlerts | every 5m | Task 7 |
| syncRaiders | every 10m | Task 4 |
| alertSignups | 7pm Mon/Tue/Fri/Sat | Task 8 |
| weeklyReports | noon Wed | Task 4 |
| updatePriorityPost | */10 cron | Task 10 |

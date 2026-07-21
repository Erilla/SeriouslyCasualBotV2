# Condensed Startup Summary in #bot-logs — Design

**Date:** 2026-07-21
**Status:** Approved

## Problem

The startup build banner is logged before Discord login, so it never reaches the
`#bot-logs` channel (the logger's Discord mirror is wired up mid-ready via
`setDiscordChannel`). Meanwhile the tail of the ready flow posts five separate
messages to `#bot-logs` on every restart:

```
[bot] Channel bootstrap complete
[scheduler] Started with 4 intervals and 3 cron jobs
[Trials] Rescheduled alerts: 0 past-due, 0 scheduled, 0 promote past-due, 0 promote scheduled
[Applications] resumeSessions: no in-progress sessions to restore
[bot] Startup complete
```

We want the build number visible in `#bot-logs`, and those five entries condensed
into one.

## Change

One INFO line replaces the five, logged at the very end of the ready handler
(after `setDiscordChannel`, so it reaches Discord):

```
Startup complete — build 187 (66c9971) | scheduler: 4 intervals, 3 cron | trials: 0 alerts rescheduled | applications: 0 sessions resumed
```

- Build/sha from `getBuildInfo()` — a SQLite cache hit at this point (the startup
  banner already resolved it). Same display fallbacks as the banner: `build ?` when
  unresolved, `(dev)` when sha is null.
- `trials: N alerts rescheduled` where N = pastDue + scheduled + promotePastDue +
  promoteScheduled.
- The pre-login lines (`Starting SeriouslyCasualBot (build …)`, `Logged in as …`,
  `Commands registered`) are unchanged — they are stdout-only by timing and stay so.

## Component changes

- **`Scheduler.start()`** (`src/scheduler/scheduler.ts`) — returns
  `{ intervals: number; crons: number }`; its own "Started with…" log drops to DEBUG.
- **`rescheduleAllAlerts()`** (`src/functions/trial-review/scheduleTrialAlerts.ts`) —
  returns `{ pastDue: number; scheduled: number; promotePastDue: number; promoteScheduled: number }`;
  the detailed breakdown log drops to DEBUG.
- **`resumeSessions()`** (`src/functions/applications/resumeSessions.ts`) — returns the
  number of sessions resumed; its INFO logs drop to DEBUG.
- **`ready.ts`** — "Channel bootstrap complete" drops to DEBUG; the final
  `logger.info('bot', 'Startup complete')` becomes the composed summary line.

Nothing is lost: the detailed lines remain at DEBUG, switchable live via `/loglevel`.
Discord traffic per restart drops from five messages to one, and that one carries the
build number.

## Error handling

Unchanged. Bootstrap/guild failures keep their existing error logs; if the Discord
channel was never set the summary still reaches stdout (Railway logs), exactly like
today's "Startup complete".

## Testing

- Unit tests updated/added for the three changed functions' return values
  (scheduler counts, rescheduleAllAlerts counts, resumeSessions count) and for the
  demotion of their logs to DEBUG where existing tests assert log calls.
- `ready.ts` stays untested by repo convention; its new logic is trivial composition.

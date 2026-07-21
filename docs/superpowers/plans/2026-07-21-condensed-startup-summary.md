# Condensed Startup Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace five per-restart `#bot-logs` messages with one summary line that carries the build number.

**Architecture:** The three chatty startup functions (`Scheduler.start`, `rescheduleAllAlerts`, `resumeSessions`) return their stats and demote their own logs to DEBUG; `ready.ts` composes a single INFO summary at the end of the ready flow (after `setDiscordChannel`, so it reaches Discord), pulling build info from the already-cached `getBuildInfo()`.

**Tech Stack:** TypeScript ESM, vitest (in-memory SQLite + mocked logger patterns already in the repo).

**Spec:** `docs/superpowers/specs/2026-07-21-condensed-startup-summary-design.md`

## Global Constraints

- ESM project: relative imports MUST end in `.js` even from `.ts` files.
- Summary line format exactly:
  `Startup complete — build 187 (66c9971) | scheduler: 4 intervals, 3 cron | trials: 0 alerts rescheduled | applications: 0 sessions resumed`
  with fallbacks `build ? (<sha7>)` when build is null and `(dev)` replacing the whole `build … (…)` segment when sha is null.
- `trials: N alerts rescheduled` where N = pastDue + scheduled + promotePastDue + promoteScheduled.
- The demoted lines keep their exact wording — only `logger.info` → `logger.debug` changes.
- The pre-login lines (`Starting SeriouslyCasualBot (build …)`, `Logged in as …`, `Commands registered`) are unchanged.
- CI blocks on prettier: run `npm run format` before every commit; run unit tests with `npm test` (never e2e — needs live Discord).
- Do NOT push to origin. Local commits only; the user pushes.

---

### Task 1: Return startup stats from the three functions

**Files:**
- Modify: `src/scheduler/scheduler.ts:90-96` (the `start()` method)
- Modify: `src/functions/trial-review/scheduleTrialAlerts.ts:248-303` (`rescheduleAllAlerts`)
- Modify: `src/functions/applications/resumeSessions.ts` (whole function)
- Test: `tests/unit/scheduler.test.ts` (append one test)
- Test: `tests/unit/startupStats.test.ts` (new file)

**Interfaces:**
- Consumes: nothing new.
- Produces (Task 2 relies on these exact signatures):
  - `Scheduler.start(): { intervals: number; crons: number }`
  - `rescheduleAllAlerts(client: Client): { pastDue: number; scheduled: number; promotePastDue: number; promoteScheduled: number }`
  - `resumeSessions(client: Client): Promise<number>` (number of sessions resumed)

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/scheduler.test.ts`, inside the existing `describe('Scheduler', ...)` block (it already creates a fresh `scheduler` in `beforeEach` and shuts it down in `afterEach`):

```typescript
  it('start() returns the registered interval and cron counts', () => {
    scheduler.registerInterval({
      name: 'a',
      intervalMs: 600_000,
      handler: vi.fn().mockResolvedValue(undefined),
    });
    scheduler.registerInterval({
      name: 'b',
      intervalMs: 600_000,
      handler: vi.fn().mockResolvedValue(undefined),
    });
    scheduler.registerCron({ name: 'c', expression: '0 4 * * *', handler: vi.fn() });

    expect(scheduler.start()).toEqual({ intervals: 2, crons: 1 });
  });
```

Create `tests/unit/startupStats.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Client } from 'discord.js';
import { getDatabase, closeDatabase } from '../../src/database/db.js';
import { createTables } from '../../src/database/schema.js';

vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { rescheduleAllAlerts } from '../../src/functions/trial-review/scheduleTrialAlerts.js';
import { resumeSessions } from '../../src/functions/applications/resumeSessions.js';
import { logger } from '../../src/services/logger.js';

const client = {} as unknown as Client;

beforeEach(() => {
  closeDatabase();
  createTables(getDatabase(':memory:'));
  vi.clearAllMocks();
});

afterEach(() => {
  closeDatabase();
});

describe('rescheduleAllAlerts — startup stats', () => {
  it('returns zero counts on an empty database and logs at DEBUG, not INFO', () => {
    const stats = rescheduleAllAlerts(client);

    expect(stats).toEqual({
      pastDue: 0,
      scheduled: 0,
      promotePastDue: 0,
      promoteScheduled: 0,
    });
    expect(logger.debug).toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });
});

describe('resumeSessions — startup stats', () => {
  it('returns 0 with no in-progress sessions and logs at DEBUG, not INFO', async () => {
    await expect(resumeSessions(client)).resolves.toBe(0);

    expect(logger.debug).toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/unit/scheduler.test.ts tests/unit/startupStats.test.ts`
Expected: FAIL — `start()` returns `undefined` (not the counts object); `rescheduleAllAlerts` returns `undefined`; `resumeSessions` resolves `undefined`; the DEBUG/INFO assertions fail because both functions currently log at INFO.

- [ ] **Step 3: Implement the three changes**

In `src/scheduler/scheduler.ts`, replace the `start()` method (lines 90-96):

```typescript
  start(): { intervals: number; crons: number } {
    this.stopped = false;
    const stats = { intervals: this.intervalTimers.size, crons: this.cronJobs.length };
    logger.debug('scheduler', `Started with ${stats.intervals} intervals and ${stats.crons} cron jobs`);
    return stats;
  }
```

In `src/functions/trial-review/scheduleTrialAlerts.ts`, change the `rescheduleAllAlerts` signature (line 248):

```typescript
export function rescheduleAllAlerts(client: Client): {
  pastDue: number;
  scheduled: number;
  promotePastDue: number;
  promoteScheduled: number;
} {
```

and replace its closing `logger.info(...)` call (lines 298-302) with:

```typescript
  logger.debug(
    'Trials',
    `Rescheduled alerts: ${pastDue} past-due, ${scheduled} scheduled, ` +
      `${promotePastDue} promote past-due, ${promoteScheduled} promote scheduled`,
  );

  return { pastDue, scheduled, promotePastDue, promoteScheduled };
```

In `src/functions/applications/resumeSessions.ts`:
- Signature (line 12): `export async function resumeSessions(client: Client): Promise<number> {`
- Early return (lines 19-22):
  ```typescript
  if (inProgress.length === 0) {
    logger.debug('Applications', 'resumeSessions: no in-progress sessions to restore');
    return 0;
  }
  ```
- The per-app success log (lines 89-92): change `logger.info(` to `logger.debug(` (wording unchanged).
- Final lines (103-107):
  ```typescript
  logger.debug(
    'Applications',
    `resumeSessions: complete — ${resumed} resumed, ${skipped} skipped out of ${inProgress.length} in-progress`,
  );

  return resumed;
  ```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/unit/scheduler.test.ts tests/unit/startupStats.test.ts`
Expected: PASS. Then run the full unit suite once: `npm test` — expected all pass (nothing else consumes these return values yet; `ready.ts` ignores them until Task 2).

- [ ] **Step 5: Format, lint, typecheck, commit**

```bash
npm run format && npm run lint && npm run typecheck
git add src/scheduler/scheduler.ts src/functions/trial-review/scheduleTrialAlerts.ts src/functions/applications/resumeSessions.ts tests/unit/scheduler.test.ts tests/unit/startupStats.test.ts
git commit -m "refactor(startup): return stats from scheduler start, alert reschedule, session resume"
```

---

### Task 2: Compose the startup summary in ready.ts

**Files:**
- Modify: `src/events/ready.ts:76` (Channel bootstrap line), `:155-163` (tail of the ready handler), plus one import

**Interfaces:**
- Consumes (from Task 1, exact signatures):
  - `Scheduler.start(): { intervals: number; crons: number }`
  - `rescheduleAllAlerts(client: Client): { pastDue: number; scheduled: number; promotePastDue: number; promoteScheduled: number }`
  - `resumeSessions(client: Client): Promise<number>`
  - `getBuildInfo(): Promise<{ build: number | null; sha: string | null }>` from `../services/buildInfo.js` (already exists; SQLite-cached, so this second call per boot is free)
- Produces: the single summary INFO line (format in Global Constraints).

- [ ] **Step 1: Make the edits**

In `src/events/ready.ts`, add to the imports:

```typescript
import { getBuildInfo } from '../services/buildInfo.js';
```

Change line 76 from `logger.info('bot', 'Channel bootstrap complete');` to:

```typescript
      logger.debug('bot', 'Channel bootstrap complete');
```

Replace the tail of the handler (currently lines 155-163):

```typescript
    scheduler.start();

    // Reschedule trial alerts from DB (must happen after scheduler.start)
    rescheduleAllAlerts(client);

    // Resume any in-progress DM application sessions from before restart
    await resumeSessions(client);

    logger.info('bot', 'Startup complete');
```

with:

```typescript
    const schedulerStats = scheduler.start();

    // Reschedule trial alerts from DB (must happen after scheduler.start)
    const trialStats = rescheduleAllAlerts(client);

    // Resume any in-progress DM application sessions from before restart
    const sessionsResumed = await resumeSessions(client);

    // One summary line instead of five — logged after setDiscordChannel, so
    // it reaches #bot-logs and carries the build number (cached lookup).
    const { build, sha } = await getBuildInfo();
    const buildLabel = sha ? `build ${build ?? '?'} (${sha.slice(0, 7)})` : '(dev)';
    const trialAlerts =
      trialStats.pastDue + trialStats.scheduled + trialStats.promotePastDue + trialStats.promoteScheduled;
    logger.info(
      'bot',
      `Startup complete — ${buildLabel} | scheduler: ${schedulerStats.intervals} intervals, ${schedulerStats.crons} cron | ` +
        `trials: ${trialAlerts} alerts rescheduled | applications: ${sessionsResumed} sessions resumed`,
    );
```

- [ ] **Step 2: Verify the composed line locally**

`ready.ts` needs a live Discord client, so verify the composition expression standalone. Write `smoke-summary.mts` at the repo root:

```typescript
import { initDatabase } from './src/database/db.js';
import { getBuildInfo } from './src/services/buildInfo.js';

initDatabase(':memory:');
const { build, sha } = await getBuildInfo();
const buildLabel = sha ? `build ${build ?? '?'} (${sha.slice(0, 7)})` : '(dev)';
const trialStats = { pastDue: 0, scheduled: 0, promotePastDue: 0, promoteScheduled: 0 };
const trialAlerts =
  trialStats.pastDue + trialStats.scheduled + trialStats.promotePastDue + trialStats.promoteScheduled;
console.log(
  `Startup complete — ${buildLabel} | scheduler: 4 intervals, 3 cron | ` +
    `trials: ${trialAlerts} alerts rescheduled | applications: 0 sessions resumed`,
);
```

Run: `npx tsx smoke-summary.mts` then `rm smoke-summary.mts`
Expected output (local git path): `Startup complete — build <N> (<sha7>) | scheduler: 4 intervals, 3 cron | trials: 0 alerts rescheduled | applications: 0 sessions resumed`

(Do NOT use `npx tsx -e` — it evaluates as CJS and top-level await fails.)

- [ ] **Step 3: Full verification**

```bash
npm test && npm run typecheck && npm run lint && npm run format:check
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/events/ready.ts
git commit -m "feat(bot): condense startup logs into one summary with build info"
```

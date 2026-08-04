# Applicant Mythic Logs and Alt Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an application is submitted, post two messages in its forum thread — every character on the applicant's Battle.net account, and their Mythic raid logs across the last three expansions — gathered by a resumable background job.

**Architecture:** Pure functions do selection, matching and rendering; thin service wrappers call Warcraft Logs, Raider.IO (documented + internal) and Blizzard through the existing `httpRequest`; a persisted job (new tables, migration v11) sequences phases so a rate limit or restart pauses rather than loses work. Placeholders are posted at forum-post creation and edited in place as phases complete.

**Tech Stack:** TypeScript (Node16 ESM, `.js` import specifiers), discord.js v14, better-sqlite3, vitest, node-cron.

## Global Constraints

- **Mythic only** — WCL `difficulty: 5`. Heroic/Normal/LFR are never shown.
- **Last three expansions** — derived from the WCL zone catalogue at runtime, never hardcoded.
- **WCL is structural, Raider.IO is decorative.** Whether a boss was killed, and every report link, come from WCL ids. Raider.IO supplies first-kill dates only. A naming mismatch costs a date, never a boss.
- **Attribution is per fight, never per report.** A report is a raid night; presence in it proves nothing about a given pull.
- **A failed fetch is never "no data".** Record unknown; a failure must never read as an absence.
- **Nothing may fail an application.** Every path fails soft.
- **Masked links only render in embeds** — both messages are embeds, URLs absolute `https://`.
- **Cache the expensive fetches by entity, never by job.** An achievement fingerprint belongs to a character and a roster belongs to a guild; neither depends on who asked. Both go through `getCachedOrFetch` keyed on `region/realm/name` or `name-realm`, so overlapping guilds across applicants are already warm. `applicant_intel_scanned` stays job-scoped — it is resume state, not data.
- **Never cache a negative.** `null` from a fingerprint means "unavailable", and caching it would freeze a transient failure into a lasting absence, which the constraint above forbids.
- Imports use `.js` specifiers; ephemeral replies use `MessageFlags.Ephemeral`.
- Every task ends prettier-clean: `npx prettier --write <files>` before commit (CI runs `format:check`).

**Spec:** `docs/superpowers/specs/2026-08-03-applicant-mythic-logs-and-alts-design.md`

---

### Task 1: Parse every Raider.IO character URL in an application

**Files:**

- Modify: `src/functions/applications/raiderIoName.ts`
- Test: `tests/unit/applicationCharacterName.test.ts`

**Interfaces:**

- Consumes: nothing
- Produces:
  - `export interface RaiderIoCharacter { region: string; realm: string; name: string }`
  - `parseRaiderIoCharacter(text: string): RaiderIoCharacter | null`
  - `collectRaiderIoCharacters(answers: { answer: string }[]): RaiderIoCharacter[]`
  - existing `parseRaiderIoCharacterName` and `deriveCharacterNameFromAnswers` keep their signatures

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/applicationCharacterName.test.ts`:

```typescript
import {
  parseRaiderIoCharacter,
  collectRaiderIoCharacters,
} from '../../src/functions/applications/raiderIoName.js';

describe('parseRaiderIoCharacter', () => {
  it('returns region, realm and name', () => {
    expect(parseRaiderIoCharacter('https://raider.io/characters/eu/draenor/Brentpriest')).toEqual({
      region: 'eu',
      realm: 'draenor',
      name: 'Brentpriest',
    });
  });

  it('keeps multi-word realm slugs intact', () => {
    expect(parseRaiderIoCharacter('https://raider.io/characters/eu/argent-dawn/Driptinus')).toEqual(
      { region: 'eu', realm: 'argent-dawn', name: 'Driptinus' },
    );
  });

  it('decodes percent-encoded names', () => {
    expect(parseRaiderIoCharacter('https://raider.io/characters/eu/silvermoon/Sk%C3%A2di')).toEqual(
      { region: 'eu', realm: 'silvermoon', name: 'Skâdi' },
    );
  });

  it('returns null when there is no character URL', () => {
    expect(parseRaiderIoCharacter('I raid on Tuesdays')).toBeNull();
  });
});

describe('collectRaiderIoCharacters', () => {
  it('collects a character from every answer, in order', () => {
    const answers = [
      { answer: 'https://raider.io/characters/eu/draenor/Brentpriest' },
      { answer: 'my alt https://raider.io/characters/eu/draenor/Brenthunter too' },
    ];
    expect(collectRaiderIoCharacters(answers).map((c) => c.name)).toEqual([
      'Brentpriest',
      'Brenthunter',
    ]);
  });

  it('collects multiple characters from a single answer', () => {
    const answers = [
      {
        answer:
          'https://raider.io/characters/eu/draenor/Brentpriest and https://raider.io/characters/eu/draenor/Brenthunter',
      },
    ];
    expect(collectRaiderIoCharacters(answers)).toHaveLength(2);
  });

  it('deduplicates case-insensitively on realm and name', () => {
    const answers = [
      { answer: 'https://raider.io/characters/eu/draenor/Brentpriest' },
      { answer: 'https://raider.io/characters/EU/draenor/brentpriest' },
    ];
    expect(collectRaiderIoCharacters(answers)).toHaveLength(1);
  });

  it('returns an empty array when no answer contains a URL', () => {
    expect(collectRaiderIoCharacters([{ answer: 'none here' }])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/applicationCharacterName.test.ts`
Expected: FAIL — `parseRaiderIoCharacter is not a function`

- [ ] **Step 3: Implement**

In `src/functions/applications/raiderIoName.ts`, keep `RAIDER_IO_CHARACTER_URL` and both existing functions untouched, and add:

```typescript
const RAIDER_IO_CHARACTER_URL_G = /raider\.io\/characters\/([^/\s]+)\/([^/\s]+)\/([^/?#\s]+)/gi;

export interface RaiderIoCharacter {
  region: string;
  realm: string;
  name: string;
}

function decodeName(raw: string): string | null {
  let name: string;
  try {
    name = decodeURIComponent(raw);
  } catch {
    name = raw;
  }
  name = name.trim();
  if (!name) return null;
  return name.charAt(0).toLocaleUpperCase() + name.slice(1);
}

/**
 * Region, realm slug and name from the first Raider.IO character URL in `text`.
 * WarcraftLogs and Blizzard both need all three, so unlike
 * parseRaiderIoCharacterName this keeps the path segments.
 */
export function parseRaiderIoCharacter(text: string): RaiderIoCharacter | null {
  const match = new RegExp(RAIDER_IO_CHARACTER_URL_G.source, 'i').exec(text);
  if (!match) return null;
  const name = decodeName(match[3]);
  if (!name) return null;
  return { region: match[1].toLowerCase(), realm: match[2].toLowerCase(), name };
}

/**
 * Every distinct character named anywhere in the answers, in order of
 * appearance. Applicants routinely link a second character ("I can also play
 * <link>") and those are always swept, so we cannot stop at the first URL the
 * way deriveCharacterNameFromAnswers does.
 */
export function collectRaiderIoCharacters(answers: { answer: string }[]): RaiderIoCharacter[] {
  const seen = new Set<string>();
  const out: RaiderIoCharacter[] = [];
  for (const a of answers) {
    for (const m of a.answer.matchAll(RAIDER_IO_CHARACTER_URL_G)) {
      const name = decodeName(m[3]);
      if (!name) continue;
      const realm = m[2].toLowerCase();
      const key = `${realm}/${name.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ region: m[1].toLowerCase(), realm, name });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/applicationCharacterName.test.ts`
Expected: PASS, including the pre-existing `parseRaiderIoCharacterName` cases

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/functions/applications/raiderIoName.ts tests/unit/applicationCharacterName.test.ts
git add src/functions/applications/raiderIoName.ts tests/unit/applicationCharacterName.test.ts
git commit -m "feat(applications): parse region/realm and collect every named character"
```

---

### Task 2: Bounded-concurrency helper

**Files:**

- Create: `src/utils/concurrency.ts`
- Test: `tests/unit/concurrency.test.ts`

**Interfaces:**

- Consumes: nothing
- Produces: `mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]>` — results in input order; rejects if any task rejects

- [ ] **Step 1: Write the failing test**

Create `tests/unit/concurrency.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mapLimit } from '../../src/utils/concurrency.js';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('mapLimit', () => {
  it('returns results in input order', async () => {
    const out = await mapLimit([3, 1, 2], 2, async (n) => {
      await tick(n * 5);
      return n * 10;
    });
    expect(out).toEqual([30, 10, 20]);
  });

  it('never exceeds the concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    await mapLimit(
      Array.from({ length: 20 }, (_, i) => i),
      4,
      async () => {
        active++;
        peak = Math.max(peak, active);
        await tick(2);
        active--;
      },
    );
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('passes the index to the callback', async () => {
    expect(await mapLimit(['a', 'b'], 1, async (item, i) => `${i}:${item}`)).toEqual([
      '0:a',
      '1:b',
    ]);
  });

  it('handles an empty input', async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
  });

  it('rejects if a task rejects', async () => {
    await expect(
      mapLimit([1, 2], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/concurrency.test.ts`
Expected: FAIL — cannot resolve `src/utils/concurrency.js`

- [ ] **Step 3: Implement**

Create `src/utils/concurrency.ts`:

```typescript
/**
 * Run `fn` over `items` with at most `limit` promises in flight, preserving
 * input order in the result.
 *
 * The alt fingerprint sweep is hundreds of Blizzard requests per guild:
 * sequential took ~3 minutes for 313 characters, eight in flight took ~13s.
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/concurrency.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/utils/concurrency.ts tests/unit/concurrency.test.ts
git add src/utils/concurrency.ts tests/unit/concurrency.test.ts
git commit -m "feat(utils): add bounded-concurrency mapLimit helper"
```

---

### Task 3: Surface `Retry-After` on HttpError and register the internal Raider.IO service

**Files:**

- Modify: `src/services/httpClient.ts`
- Modify: `src/services/apiHealth.ts` (line 1 `ServiceName`, line 41 `SERVICES`)
- Modify: `src/commands/status.ts`
- Test: `tests/unit/httpClientRetryAfter.test.ts`

**Interfaces:**

- Consumes: nothing
- Produces: `HttpError.retryAfterMs?: number` (uncapped milliseconds); `ServiceName` gains `'raiderio-internal'`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/httpClientRetryAfter.test.ts`:

```typescript
import { describe, it, expect, afterEach, vi } from 'vitest';
import { httpRequest, HttpError } from '../../src/services/httpClient.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('HttpError.retryAfterMs', () => {
  it('carries Retry-After seconds from a 429 as milliseconds', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('slow down', { status: 429, headers: { 'Retry-After': '120' } }),
    ) as unknown as typeof fetch;

    const err = (await httpRequest('raiderio', 'https://example.test/x', {
      maxRetries: 0,
    }).catch((e: unknown) => e)) as HttpError;

    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(120_000);
  });

  it('leaves retryAfterMs undefined when the header is absent', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('nope', { status: 429 }),
    ) as unknown as typeof fetch;

    const err = (await httpRequest('raiderio', 'https://example.test/x', {
      maxRetries: 0,
    }).catch((e: unknown) => e)) as HttpError;

    expect(err.retryAfterMs).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/httpClientRetryAfter.test.ts`
Expected: FAIL — `retryAfterMs` undefined in the first case

- [ ] **Step 3: Implement**

In `src/services/httpClient.ts`, add to `HttpError` alongside the existing `status` handling:

```typescript
  readonly retryAfterMs?: number;
```

```typescript
    retryAfterMs?: number;
```

```typescript
this.retryAfterMs = args.retryAfterMs;
```

The module already reads `Retry-After` for its internal sleep. Capture it into a loop-scoped variable next to the existing `lastStatus` assignment and pass it to **every** `new HttpError({...})` site in the file:

```typescript
let lastRetryAfterMs: number | undefined;
// …where the response is inspected, next to `lastStatus = response.status;`
const retryAfterHeader = response.headers.get('Retry-After');
if (retryAfterHeader) {
  const seconds = Number(retryAfterHeader);
  if (Number.isFinite(seconds) && seconds > 0) lastRetryAfterMs = seconds * 1000;
}
```

`RETRY_AFTER_CAP_MS` still clamps the internal sleep; `retryAfterMs` on the error is deliberately **uncapped**, because the job scheduler needs the real wait, which can be minutes.

In `src/services/apiHealth.ts`:

```typescript
export type ServiceName =
  | 'blizzard'
  | 'raiderio'
  | 'raiderio-internal'
  | 'warcraftlogs'
  | 'wowaudit';
```

```typescript
const SERVICES: ServiceName[] = [
  'blizzard',
  'raiderio',
  'raiderio-internal',
  'warcraftlogs',
  'wowaudit',
];
```

In `src/commands/status.ts`, duplicate the existing `Raider.io` health field object and change its two values to `'Raider.io (internal)'` and `apiSummaries['raiderio-internal']`. Copy the neighbouring literal's exact shape rather than inventing one.

The separate key exists so a break in the undocumented internal endpoints cannot open the breaker for the documented API that `getGuildRoster` and the achievements image depend on.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/httpClientRetryAfter.test.ts && npx vitest run && npx tsc --noEmit`
Expected: PASS with no type errors

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/services/httpClient.ts src/services/apiHealth.ts src/commands/status.ts tests/unit/httpClientRetryAfter.test.ts
git add src/services/httpClient.ts src/services/apiHealth.ts src/commands/status.ts tests/unit/httpClientRetryAfter.test.ts
git commit -m "feat(http): expose Retry-After on HttpError, add raiderio-internal service"
```

---

### Task 4: Rate-limit classification and backoff (pure)

**Files:**

- Create: `src/functions/applications/intel/rateLimit.ts`
- Test: `tests/unit/intelRateLimit.test.ts`

**Interfaces:**

- Consumes: `HttpError`, `CircuitOpenError`, `ServiceName` (Task 3)
- Produces:
  - `export interface PauseDecision { pause: boolean; service?: ServiceName; resumeAfterMs?: number }`
  - `classifyError(error: unknown, attempts: number): PauseDecision`
  - `backoffMs(attempts: number): number`
  - `shouldPreemptWclPoints(pointsSpentThisHour: number, limitPerHour: number): boolean`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/intelRateLimit.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  classifyError,
  backoffMs,
  shouldPreemptWclPoints,
} from '../../src/functions/applications/intel/rateLimit.js';
import { HttpError, CircuitOpenError } from '../../src/services/httpClient.js';

describe('classifyError', () => {
  it('pauses on 429 and honours Retry-After', () => {
    const err = new HttpError({
      service: 'blizzard',
      status: 429,
      attempts: 1,
      message: 'rate limited',
      retryAfterMs: 90_000,
    });
    expect(classifyError(err, 1)).toEqual({
      pause: true,
      service: 'blizzard',
      resumeAfterMs: 90_000,
    });
  });

  it('pauses on 429 without Retry-After using the backoff schedule', () => {
    const err = new HttpError({
      service: 'warcraftlogs',
      status: 429,
      attempts: 1,
      message: 'rate limited',
    });
    expect(classifyError(err, 1)).toEqual({
      pause: true,
      service: 'warcraftlogs',
      resumeAfterMs: backoffMs(1),
    });
  });

  it('pauses on an open circuit', () => {
    expect(classifyError(new CircuitOpenError('raiderio'), 2)).toEqual({
      pause: true,
      service: 'raiderio',
      resumeAfterMs: backoffMs(2),
    });
  });

  it('does not pause on a 404', () => {
    const err = new HttpError({
      service: 'raiderio',
      status: 404,
      attempts: 1,
      message: 'not found',
    });
    expect(classifyError(err, 1)).toEqual({ pause: false });
  });

  it('does not pause on a non-HTTP error', () => {
    expect(classifyError(new Error('boom'), 1)).toEqual({ pause: false });
  });
});

describe('backoffMs', () => {
  it('escalates 5min, 15min, 60min and caps at an hour', () => {
    expect(backoffMs(1)).toBe(5 * 60_000);
    expect(backoffMs(2)).toBe(15 * 60_000);
    expect(backoffMs(3)).toBe(60 * 60_000);
    expect(backoffMs(9)).toBe(60 * 60_000);
  });

  it('treats a zeroth attempt as the first step', () => {
    expect(backoffMs(0)).toBe(5 * 60_000);
  });
});

describe('shouldPreemptWclPoints', () => {
  it('pre-empts at or above 90% of the hourly budget', () => {
    expect(shouldPreemptWclPoints(8100, 9000)).toBe(true);
    expect(shouldPreemptWclPoints(8999, 9000)).toBe(true);
  });

  it('does not pre-empt below 90%', () => {
    expect(shouldPreemptWclPoints(4000, 9000)).toBe(false);
  });

  it('does not pre-empt when the limit is unknown', () => {
    expect(shouldPreemptWclPoints(4000, 0)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/intelRateLimit.test.ts`
Expected: FAIL — cannot resolve the module

- [ ] **Step 3: Implement**

Create `src/functions/applications/intel/rateLimit.ts`:

```typescript
import { HttpError, CircuitOpenError, type ServiceName } from '../../../services/httpClient.js';

export interface PauseDecision {
  pause: boolean;
  service?: ServiceName;
  resumeAfterMs?: number;
}

/** 5min -> 15min -> 60min, capped. An hour is the natural window for both the
 *  Blizzard hourly request budget and the WarcraftLogs hourly points budget. */
const BACKOFF_STEPS_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000];

export function backoffMs(attempts: number): number {
  const index = Math.min(Math.max(attempts, 1), BACKOFF_STEPS_MS.length) - 1;
  return BACKOFF_STEPS_MS[index];
}

/**
 * Whether an error should pause the whole job (rate limiting) or merely fail
 * the current work item. Only 429s and an open circuit pause, so a permanently
 * broken item cannot stall the job forever.
 */
export function classifyError(error: unknown, attempts: number): PauseDecision {
  if (error instanceof CircuitOpenError) {
    return { pause: true, service: error.service, resumeAfterMs: backoffMs(attempts) };
  }
  if (error instanceof HttpError && error.status === 429) {
    return {
      pause: true,
      service: error.service,
      resumeAfterMs: error.retryAfterMs ?? backoffMs(attempts),
    };
  }
  return { pause: false };
}

export const WCL_POINTS_PREEMPT_RATIO = 0.9;

/**
 * WarcraftLogs bills by points, not requests, so a 429 is the last signal you
 * get. Every query asks for rateLimitData; pause at 90% of the hourly budget
 * rather than waiting to be refused.
 */
export function shouldPreemptWclPoints(pointsSpentThisHour: number, limitPerHour: number): boolean {
  if (!limitPerHour || limitPerHour <= 0) return false;
  return pointsSpentThisHour >= limitPerHour * WCL_POINTS_PREEMPT_RATIO;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/intelRateLimit.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/functions/applications/intel/rateLimit.ts tests/unit/intelRateLimit.test.ts
git add src/functions/applications/intel/rateLimit.ts tests/unit/intelRateLimit.test.ts
git commit -m "feat(intel): classify rate-limit errors and compute resume backoff"
```

---

### Task 5: Migration v11 and the job store

**Files:**

- Modify: `src/database/schema.ts` (add four tables to `createTables`)
- Modify: `src/database/db.ts` (append a `currentVersion < 11` block after the `< 10` block, which ends at line 227)
- Modify: `src/types/index.ts`
- Create: `src/functions/applications/intel/jobStore.ts`
- Test: `tests/unit/intelJobStore.test.ts`

**Interfaces:**

- Consumes: `getDatabase`, `RaiderIoCharacter` (Task 1)
- Produces:
  - `export type JobPhase = 'logs' | 'alt_sources' | 'fingerprint' | 'alt_logs' | 'done'`
  - `export type JobStatus = 'pending' | 'running' | 'paused' | 'done' | 'failed'`
  - `export type FindingSource = 'application' | 'raider.io' | 'declared main' | 'fingerprint'`
  - `export interface IntelFinding { name: string; realm: string; className: string | null; guildName: string | null; guildRealm: string | null; source: FindingSource; confidence: number | null }`
  - `createJob({ applicationId: number | null; targetChannelId: string; character: RaiderIoCharacter }): number`
  - `getJob(id): IntelJobRow | undefined`, `setPhase(id, phase)`, `setStatus(id, status)`, `pauseJob(id, service, resumeAfterMs)`
  - `dueJobs(nowIso: string): IntelJobRow[]`, `resetRunningJobs(): number`, `setMessageIds(id, { alts?, logs? })`
  - `enqueue(jobId, kind, key, payload?)`, `pendingQueue(jobId, kind)`, `markQueueDone(jobId, kind, key)`
  - `markScanned(jobId, characterKey)`, `isScanned(jobId, characterKey)`, `scannedCount(jobId)`
  - `addFinding(jobId, f: IntelFinding)`, `getFindings(jobId): IntelFinding[]`
  - `IntelJobRow` exported from `src/types/index.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/intelJobStore.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { closeDatabase, getDatabase } from '../../src/database/db.js';
import { createTables } from '../../src/database/schema.js';

vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  createJob,
  getJob,
  pauseJob,
  dueJobs,
  resetRunningJobs,
  setStatus,
  setMessageIds,
  enqueue,
  pendingQueue,
  markQueueDone,
  markScanned,
  isScanned,
  scannedCount,
  addFinding,
  getFindings,
} from '../../src/functions/applications/intel/jobStore.js';

const character = { region: 'eu', realm: 'draenor', name: 'Brentpriest' };

describe('intel job store', () => {
  beforeEach(() => {
    process.env.DATABASE_PATH = ':memory:';
    createTables(getDatabase());
  });
  afterEach(() => closeDatabase());

  it('creates a job in the pending/logs state', () => {
    const id = createJob({ applicationId: 7, targetChannelId: '123', character });
    const job = getJob(id);
    expect(job?.status).toBe('pending');
    expect(job?.phase).toBe('logs');
    expect(job?.application_id).toBe(7);
    expect(job?.target_channel_id).toBe('123');
    expect(job?.character_name).toBe('Brentpriest');
  });

  it('allows a null application_id for ad-hoc /test runs', () => {
    const id = createJob({ applicationId: null, targetChannelId: '999', character });
    expect(getJob(id)?.application_id).toBeNull();
  });

  it('pauses with a resume time, a service and an incremented attempt count', () => {
    const id = createJob({ applicationId: 1, targetChannelId: '1', character });
    pauseJob(id, 'blizzard', 60_000);
    const job = getJob(id)!;
    expect(job.status).toBe('paused');
    expect(job.paused_service).toBe('blizzard');
    expect(job.attempts).toBe(1);
    expect(new Date(job.resume_after!).getTime()).toBeGreaterThan(Date.now());
  });

  it('returns only jobs whose resume time has passed', () => {
    const past = createJob({ applicationId: 1, targetChannelId: '1', character });
    pauseJob(past, 'blizzard', -1000);
    const future = createJob({ applicationId: 2, targetChannelId: '1', character });
    pauseJob(future, 'blizzard', 600_000);

    const due = dueJobs(new Date().toISOString()).map((j) => j.id);
    expect(due).toContain(past);
    expect(due).not.toContain(future);
  });

  it('includes pending jobs in dueJobs', () => {
    const id = createJob({ applicationId: 1, targetChannelId: '1', character });
    expect(dueJobs(new Date().toISOString()).map((j) => j.id)).toContain(id);
  });

  it('resets running jobs to pending for crash recovery', () => {
    const id = createJob({ applicationId: 1, targetChannelId: '1', character });
    setStatus(id, 'running');
    expect(resetRunningJobs()).toBe(1);
    expect(getJob(id)?.status).toBe('pending');
  });

  it('stores message ids independently', () => {
    const id = createJob({ applicationId: 1, targetChannelId: '1', character });
    setMessageIds(id, { alts: 'A' });
    setMessageIds(id, { logs: 'L' });
    const job = getJob(id)!;
    expect(job.alts_message_id).toBe('A');
    expect(job.logs_message_id).toBe('L');
  });

  it('tracks queue items and marks them done', () => {
    const id = createJob({ applicationId: 1, targetChannelId: '1', character });
    enqueue(id, 'guild', 'Rancour-draenor', { depth: 0 });
    enqueue(id, 'guild', 'Rancour-draenor', { depth: 0 });
    expect(pendingQueue(id, 'guild')).toEqual([{ key: 'Rancour-draenor', payload: { depth: 0 } }]);
    markQueueDone(id, 'guild', 'Rancour-draenor');
    expect(pendingQueue(id, 'guild')).toEqual([]);
  });

  it('records scanned characters idempotently', () => {
    const id = createJob({ applicationId: 1, targetChannelId: '1', character });
    markScanned(id, 'Gorre-Outland');
    markScanned(id, 'gorre-outland');
    expect(isScanned(id, 'gorre-outland')).toBe(true);
    expect(isScanned(id, 'someone-else')).toBe(false);
    expect(scannedCount(id)).toBe(1);
  });

  it('keeps the strongest source when the same character is found twice', () => {
    const id = createJob({ applicationId: 1, targetChannelId: '1', character });
    const base = {
      name: 'Gorre',
      realm: 'Outland',
      className: 'Death Knight',
      guildName: 'Goodlife',
      guildRealm: 'Tarren Mill',
    };
    addFinding(id, { ...base, source: 'fingerprint', confidence: 83 });
    addFinding(id, { ...base, source: 'raider.io', confidence: 100 });
    addFinding(id, { ...base, source: 'fingerprint', confidence: 83 });

    const found = getFindings(id);
    expect(found).toHaveLength(1);
    expect(found[0].source).toBe('raider.io');
    expect(found[0].confidence).toBe(100);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/intelJobStore.test.ts`
Expected: FAIL — cannot resolve `jobStore.js`

- [ ] **Step 3: Add the tables to `createTables`**

In `src/database/schema.ts`, following the existing numbered-comment style:

```sql
    -- 27. applicant intel: resumable per-applicant sweep (jobs, work queue,
    -- scanned characters, findings). Normalised rather than a JSON blob
    -- because the scanned set reaches thousands of rows written one at a time.
    CREATE TABLE IF NOT EXISTS applicant_intel_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER,
      target_channel_id TEXT,
      character_name TEXT NOT NULL,
      character_realm TEXT NOT NULL,
      character_region TEXT NOT NULL,
      phase TEXT NOT NULL DEFAULT 'logs',
      status TEXT NOT NULL DEFAULT 'pending',
      resume_after TEXT,
      paused_service TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      logs_message_id TEXT,
      alts_message_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS applicant_intel_queue (
      job_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      payload TEXT,
      done INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (job_id, kind, key)
    );

    CREATE TABLE IF NOT EXISTS applicant_intel_scanned (
      job_id INTEGER NOT NULL,
      character_key TEXT NOT NULL,
      PRIMARY KEY (job_id, character_key)
    );

    CREATE TABLE IF NOT EXISTS applicant_intel_findings (
      job_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      realm TEXT NOT NULL,
      class TEXT,
      guild_name TEXT,
      guild_realm TEXT,
      source TEXT NOT NULL,
      confidence REAL,
      PRIMARY KEY (job_id, name, realm)
    );
```

- [ ] **Step 4: Add migration v11**

In `src/database/db.ts`, after the `currentVersion < 10` block:

```typescript
if (currentVersion < 11) {
  // Applicant intel: a resumable background sweep needs its progress on disk
  // so a rate-limit pause or a restart costs time, not work. Fresh DBs get
  // these from createTables; IF NOT EXISTS keeps this idempotent there.
  database.transaction(() => {
    database.exec(`
        CREATE TABLE IF NOT EXISTS applicant_intel_jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          application_id INTEGER,
          target_channel_id TEXT,
          character_name TEXT NOT NULL,
          character_realm TEXT NOT NULL,
          character_region TEXT NOT NULL,
          phase TEXT NOT NULL DEFAULT 'logs',
          status TEXT NOT NULL DEFAULT 'pending',
          resume_after TEXT,
          paused_service TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          logs_message_id TEXT,
          alts_message_id TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS applicant_intel_queue (
          job_id INTEGER NOT NULL,
          kind TEXT NOT NULL,
          key TEXT NOT NULL,
          payload TEXT,
          done INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (job_id, kind, key)
        );
        CREATE TABLE IF NOT EXISTS applicant_intel_scanned (
          job_id INTEGER NOT NULL,
          character_key TEXT NOT NULL,
          PRIMARY KEY (job_id, character_key)
        );
        CREATE TABLE IF NOT EXISTS applicant_intel_findings (
          job_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          realm TEXT NOT NULL,
          class TEXT,
          guild_name TEXT,
          guild_realm TEXT,
          source TEXT NOT NULL,
          confidence REAL,
          PRIMARY KEY (job_id, name, realm)
        );
      `);
    database.prepare('INSERT INTO schema_version (version) VALUES (?)').run(11);
  })();
}
```

In `src/types/index.ts`, beside the other `*Row` interfaces:

```typescript
export interface IntelJobRow {
  id: number;
  application_id: number | null;
  target_channel_id: string | null;
  character_name: string;
  character_realm: string;
  character_region: string;
  phase: string;
  status: string;
  resume_after: string | null;
  paused_service: string | null;
  attempts: number;
  logs_message_id: string | null;
  alts_message_id: string | null;
  created_at: string;
  updated_at: string;
}
```

- [ ] **Step 5: Implement the store**

Create `src/functions/applications/intel/jobStore.ts`:

```typescript
import { getDatabase } from '../../../database/db.js';
import type { IntelJobRow } from '../../../types/index.js';
import type { RaiderIoCharacter } from '../raiderIoName.js';

export type JobPhase = 'logs' | 'alt_sources' | 'fingerprint' | 'alt_logs' | 'done';
export type JobStatus = 'pending' | 'running' | 'paused' | 'done' | 'failed';
export type FindingSource = 'application' | 'raider.io' | 'declared main' | 'fingerprint';

export interface IntelFinding {
  name: string;
  realm: string;
  className: string | null;
  guildName: string | null;
  guildRealm: string | null;
  source: FindingSource;
  confidence: number | null;
}

/** Strongest-first: a later fingerprint hit must never downgrade a Raider.IO
 *  fact, and nothing outranks a character the applicant named themselves. */
const SOURCE_RANK: Record<FindingSource, number> = {
  application: 3,
  'raider.io': 2,
  'declared main': 2,
  fingerprint: 1,
};

function touch(id: number): void {
  getDatabase()
    .prepare("UPDATE applicant_intel_jobs SET updated_at = datetime('now') WHERE id = ?")
    .run(id);
}

export function createJob(input: {
  applicationId: number | null;
  targetChannelId: string;
  character: RaiderIoCharacter;
}): number {
  const result = getDatabase()
    .prepare(
      `INSERT INTO applicant_intel_jobs
         (application_id, target_channel_id, character_name, character_realm, character_region)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      input.applicationId,
      input.targetChannelId,
      input.character.name,
      input.character.realm,
      input.character.region,
    );
  return result.lastInsertRowid as number;
}

export function getJob(id: number): IntelJobRow | undefined {
  return getDatabase().prepare('SELECT * FROM applicant_intel_jobs WHERE id = ?').get(id) as
    | IntelJobRow
    | undefined;
}

export function setPhase(id: number, phase: JobPhase): void {
  getDatabase().prepare('UPDATE applicant_intel_jobs SET phase = ? WHERE id = ?').run(phase, id);
  touch(id);
}

export function setStatus(id: number, status: JobStatus): void {
  getDatabase()
    .prepare(
      `UPDATE applicant_intel_jobs
         SET status = ?, resume_after = NULL, paused_service = NULL
       WHERE id = ?`,
    )
    .run(status, id);
  touch(id);
}

export function pauseJob(id: number, service: string, resumeAfterMs: number): void {
  const resumeAt = new Date(Date.now() + resumeAfterMs).toISOString();
  getDatabase()
    .prepare(
      `UPDATE applicant_intel_jobs
         SET status = 'paused', paused_service = ?, resume_after = ?, attempts = attempts + 1
       WHERE id = ?`,
    )
    .run(service, resumeAt, id);
  touch(id);
}

/** Pending jobs, plus paused jobs whose wait has elapsed. */
export function dueJobs(nowIso: string): IntelJobRow[] {
  return getDatabase()
    .prepare(
      `SELECT * FROM applicant_intel_jobs
        WHERE status = 'pending'
           OR (status = 'paused' AND resume_after IS NOT NULL AND resume_after <= ?)
        ORDER BY id`,
    )
    .all(nowIso) as IntelJobRow[];
}

/** A job left 'running' by a crash can never resume itself; reset it. */
export function resetRunningJobs(): number {
  return getDatabase()
    .prepare("UPDATE applicant_intel_jobs SET status = 'pending' WHERE status = 'running'")
    .run().changes;
}

export function setMessageIds(id: number, ids: { alts?: string; logs?: string }): void {
  const db = getDatabase();
  if (ids.alts !== undefined) {
    db.prepare('UPDATE applicant_intel_jobs SET alts_message_id = ? WHERE id = ?').run(
      ids.alts,
      id,
    );
  }
  if (ids.logs !== undefined) {
    db.prepare('UPDATE applicant_intel_jobs SET logs_message_id = ? WHERE id = ?').run(
      ids.logs,
      id,
    );
  }
  touch(id);
}

export function enqueue(jobId: number, kind: string, key: string, payload?: unknown): void {
  getDatabase()
    .prepare(
      `INSERT INTO applicant_intel_queue (job_id, kind, key, payload)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(job_id, kind, key) DO NOTHING`,
    )
    .run(jobId, kind, key, payload === undefined ? null : JSON.stringify(payload));
}

export function pendingQueue(jobId: number, kind: string): { key: string; payload: unknown }[] {
  const rows = getDatabase()
    .prepare(
      'SELECT key, payload FROM applicant_intel_queue WHERE job_id = ? AND kind = ? AND done = 0 ORDER BY rowid',
    )
    .all(jobId, kind) as { key: string; payload: string | null }[];
  return rows.map((r) => ({ key: r.key, payload: r.payload ? JSON.parse(r.payload) : null }));
}

export function markQueueDone(jobId: number, kind: string, key: string): void {
  getDatabase()
    .prepare('UPDATE applicant_intel_queue SET done = 1 WHERE job_id = ? AND kind = ? AND key = ?')
    .run(jobId, kind, key);
}

export function markScanned(jobId: number, characterKey: string): void {
  getDatabase()
    .prepare(
      'INSERT INTO applicant_intel_scanned (job_id, character_key) VALUES (?, ?) ON CONFLICT DO NOTHING',
    )
    .run(jobId, characterKey.toLowerCase());
}

export function isScanned(jobId: number, characterKey: string): boolean {
  return Boolean(
    getDatabase()
      .prepare(
        'SELECT 1 AS hit FROM applicant_intel_scanned WHERE job_id = ? AND character_key = ?',
      )
      .get(jobId, characterKey.toLowerCase()),
  );
}

export function scannedCount(jobId: number): number {
  const row = getDatabase()
    .prepare('SELECT COUNT(*) AS n FROM applicant_intel_scanned WHERE job_id = ?')
    .get(jobId) as { n: number };
  return row.n;
}

export function addFinding(jobId: number, f: IntelFinding): void {
  const db = getDatabase();
  const existing = db
    .prepare(
      'SELECT source FROM applicant_intel_findings WHERE job_id = ? AND name = ? AND realm = ?',
    )
    .get(jobId, f.name, f.realm) as { source: FindingSource } | undefined;
  if (existing && SOURCE_RANK[existing.source] >= SOURCE_RANK[f.source]) return;

  db.prepare(
    `INSERT INTO applicant_intel_findings
       (job_id, name, realm, class, guild_name, guild_realm, source, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(job_id, name, realm) DO UPDATE SET
       class = excluded.class,
       guild_name = excluded.guild_name,
       guild_realm = excluded.guild_realm,
       source = excluded.source,
       confidence = excluded.confidence`,
  ).run(jobId, f.name, f.realm, f.className, f.guildName, f.guildRealm, f.source, f.confidence);
}

export function getFindings(jobId: number): IntelFinding[] {
  const rows = getDatabase()
    .prepare('SELECT * FROM applicant_intel_findings WHERE job_id = ? ORDER BY rowid')
    .all(jobId) as {
    name: string;
    realm: string;
    class: string | null;
    guild_name: string | null;
    guild_realm: string | null;
    source: FindingSource;
    confidence: number | null;
  }[];
  return rows.map((r) => ({
    name: r.name,
    realm: r.realm,
    className: r.class,
    guildName: r.guild_name,
    guildRealm: r.guild_realm,
    source: r.source,
    confidence: r.confidence,
  }));
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/intelJobStore.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 7: Verify the migration applies to an existing database**

```bash
cp db.sqlite /tmp/pre-v11.sqlite
DATABASE_PATH=/tmp/pre-v11.sqlite npx vitest run tests/unit/intelJobStore.test.ts
node -e "const d=require('better-sqlite3')('/tmp/pre-v11.sqlite',{readonly:true});console.log(d.prepare('SELECT MAX(version) v FROM schema_version').get());console.log(d.prepare(\"SELECT name FROM sqlite_master WHERE name LIKE 'applicant_intel%'\").all());"
```

Expected: version `11` and all four tables present, with the pre-existing tables untouched.

- [ ] **Step 8: Commit**

```bash
npx prettier --write src/database/schema.ts src/database/db.ts src/types/index.ts src/functions/applications/intel/jobStore.ts tests/unit/intelJobStore.test.ts
git add src/database/schema.ts src/database/db.ts src/types/index.ts src/functions/applications/intel/jobStore.ts tests/unit/intelJobStore.test.ts
git commit -m "feat(intel): add migration v11 and the resumable job store"
```

---

### Task 6: Warcraft Logs zone catalogue

**Files:**

- Create: `src/functions/applications/mythic-logs/zoneCatalogue.ts`
- Modify: `src/services/warcraftlogs.ts`
- Test: `tests/unit/zoneCatalogue.test.ts`

**Interfaces:**

- Consumes: existing `getAccessToken`, `httpRequest`, `logger` inside `warcraftlogs.ts`
- Produces:
  - `export interface WclEncounter { id: number; name: string }`
  - `export interface WclZone { id: number; name: string; expansion: string; encounters: WclEncounter[] }`
  - `export interface WclExpansion { id: number; name: string; zones: { id: number; name: string; difficulties: { id: number; name: string }[]; encounters: WclEncounter[] }[] }`
  - `export const MYTHIC_DIFFICULTY = 5`
  - `selectMythicRaidZones(expansions: WclExpansion[], expansionsBack?: number): WclZone[]`
  - `getZoneCatalogue(): Promise<WclZone[]>` and `resetZoneCatalogueCache(): void` in `warcraftlogs.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/zoneCatalogue.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  selectMythicRaidZones,
  type WclExpansion,
} from '../../src/functions/applications/mythic-logs/zoneCatalogue.js';

const MYTHIC = { id: 5, name: 'Mythic' };
const DUNGEON = { id: 10, name: 'Dungeon' };
const bosses = (...names: string[]) => names.map((name, i) => ({ id: 100 + i, name }));

const expansions: WclExpansion[] = [
  {
    id: 7,
    name: 'Midnight',
    zones: [
      { id: 46, name: 'VS / DR / MQD', difficulties: [MYTHIC], encounters: bosses('A', 'B') },
      { id: 47, name: 'Mythic+ Season 1', difficulties: [DUNGEON], encounters: bosses('D1', 'D2') },
      {
        id: 48,
        name: 'VS / DR / MQD (Beta)',
        difficulties: [MYTHIC],
        encounters: bosses('A', 'B'),
      },
      { id: 50, name: 'Sporefall', difficulties: [MYTHIC], encounters: bosses('Rotmire') },
      {
        id: 509,
        name: 'Complete Raids (VS)',
        difficulties: [MYTHIC],
        encounters: bosses('X', 'Y'),
      },
      { id: 52, name: 'Dummy Dome', difficulties: [MYTHIC], encounters: bosses('S', 'T') },
    ],
  },
  {
    id: 6,
    name: 'The War Within',
    zones: [
      { id: 44, name: 'Manaforge Omega', difficulties: [MYTHIC], encounters: bosses('P', 'Q') },
    ],
  },
  {
    id: 5,
    name: 'Dragonflight',
    zones: [{ id: 35, name: 'Amirdrassil', difficulties: [MYTHIC], encounters: bosses('G', 'F') }],
  },
  {
    id: 4,
    name: 'Shadowlands',
    zones: [{ id: 29, name: 'Sepulcher', difficulties: [MYTHIC], encounters: bosses('V', 'J') }],
  },
];

describe('selectMythicRaidZones', () => {
  it('keeps only zones from the newest three expansions', () => {
    const names = selectMythicRaidZones(expansions).map((z) => z.name);
    expect(names).toEqual(
      expect.arrayContaining(['VS / DR / MQD', 'Manaforge Omega', 'Amirdrassil']),
    );
    expect(names).not.toContain('Sepulcher');
  });

  it('excludes dungeon-only zones', () => {
    expect(selectMythicRaidZones(expansions).map((z) => z.id)).not.toContain(47);
  });

  it('excludes the >= 500 Complete Raids rollups', () => {
    expect(selectMythicRaidZones(expansions).map((z) => z.id)).not.toContain(509);
  });

  it('excludes PTR, Beta and Dummy Dome zones', () => {
    const ids = selectMythicRaidZones(expansions).map((z) => z.id);
    expect(ids).not.toContain(48);
    expect(ids).not.toContain(52);
  });

  it('excludes single-boss zones', () => {
    expect(selectMythicRaidZones(expansions).map((z) => z.id)).not.toContain(50);
  });

  it('carries the expansion name and preserves boss order', () => {
    const zone = selectMythicRaidZones(expansions).find((z) => z.id === 44)!;
    expect(zone.expansion).toBe('The War Within');
    expect(zone.encounters.map((e) => e.name)).toEqual(['P', 'Q']);
  });

  it('honours a custom expansion depth', () => {
    expect(selectMythicRaidZones(expansions, 1).map((z) => z.id)).toEqual([46]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/zoneCatalogue.test.ts`
Expected: FAIL — cannot resolve the module

- [ ] **Step 3: Implement the pure filter**

Create `src/functions/applications/mythic-logs/zoneCatalogue.ts`:

```typescript
export interface WclEncounter {
  id: number;
  name: string;
}

export interface WclZone {
  id: number;
  name: string;
  expansion: string;
  encounters: WclEncounter[];
}

export interface WclExpansion {
  id: number;
  name: string;
  zones: {
    id: number;
    name: string;
    difficulties: { id: number; name: string }[];
    encounters: WclEncounter[];
  }[];
}

export const MYTHIC_DIFFICULTY = 5;
const DEFAULT_EXPANSIONS_BACK = 3;
/** Zone ids at or above this are "Complete Raids (…)" rollups, not real zones. */
const ROLLUP_ZONE_ID_FLOOR = 500;
const NON_LIVE_ZONE = /\bPTR\b|\bBeta\b|Dummy Dome/i;

/**
 * Mythic raid zones from the newest `expansionsBack` expansions. A zone's
 * `encounters` array is in boss order, so its index is the boss's depth — that
 * ordering is the whole basis of "later boss wins".
 */
export function selectMythicRaidZones(
  expansions: WclExpansion[],
  expansionsBack = DEFAULT_EXPANSIONS_BACK,
): WclZone[] {
  const newest = [...expansions].sort((a, b) => b.id - a.id).slice(0, expansionsBack);
  const out: WclZone[] = [];
  for (const expansion of newest) {
    for (const zone of expansion.zones) {
      if (!zone.difficulties.some((d) => d.id === MYTHIC_DIFFICULTY)) continue;
      if (zone.id >= ROLLUP_ZONE_ID_FLOOR) continue;
      if (NON_LIVE_ZONE.test(zone.name)) continue;
      if (zone.encounters.length < 2) continue;
      out.push({
        id: zone.id,
        name: zone.name,
        expansion: expansion.name,
        encounters: zone.encounters,
      });
    }
  }
  return out;
}
```

- [ ] **Step 4: Add the cached fetcher**

Append to `src/services/warcraftlogs.ts`:

```typescript
import {
  selectMythicRaidZones,
  type WclExpansion,
  type WclZone,
} from '../functions/applications/mythic-logs/zoneCatalogue.js';

const ZONE_CATALOGUE_QUERY = `
  query zoneCatalogue {
    worldData {
      expansions {
        id
        name
        zones {
          id
          name
          difficulties { id name }
          encounters { id name }
        }
      }
    }
  }
`;

let cachedZones: WclZone[] | null = null;

/**
 * Mythic raid zones for the last three expansions, cached for the process
 * lifetime — the catalogue changes only on patch day and the query costs ~19
 * rate-limit points.
 */
export async function getZoneCatalogue(): Promise<WclZone[]> {
  if (cachedZones) return cachedZones;
  const token = await getAccessToken();
  const result = await httpRequest<{ data: { worldData: { expansions: WclExpansion[] } } }>(
    'warcraftlogs',
    'https://www.warcraftlogs.com/api/v2/client',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: ZONE_CATALOGUE_QUERY }),
    },
  );
  cachedZones = selectMythicRaidZones(result.data.worldData.expansions);
  logger.debug('WarcraftLogs', `Zone catalogue: ${cachedZones.length} Mythic raid zones`);
  return cachedZones;
}

/** Testing seam — clears the process cache. */
export function resetZoneCatalogueCache(): void {
  cachedZones = null;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/zoneCatalogue.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
npx prettier --write src/functions/applications/mythic-logs/zoneCatalogue.ts src/services/warcraftlogs.ts tests/unit/zoneCatalogue.test.ts
git add src/functions/applications/mythic-logs/zoneCatalogue.ts src/services/warcraftlogs.ts tests/unit/zoneCatalogue.test.ts
git commit -m "feat(logs): derive the Mythic raid zone catalogue from WCL"
```

---

### Task 7: Warcraft Logs per-character kill, report and wipe queries

**Files:**

- Modify: `src/services/warcraftlogs.ts`
- Test: `tests/unit/warcraftlogsIntel.test.ts`

**Interfaces:**

- Consumes: `shouldPreemptWclPoints` (Task 4), `RaiderIoCharacter` (Task 1)
- Produces:
  - `export class WclPointsExhausted extends Error { readonly service: 'warcraftlogs' }`
  - `export interface ZoneKill { encounterId: number; totalKills: number }` / `getZoneKills(c, zoneId): Promise<ZoneKill[]>`
  - `export interface EncounterKill { reportCode: string; startTime: number }` / `getEncounterKills(c, encounterId): Promise<EncounterKill[]>` (ascending)
  - `export interface RaidReportRef { code: string; startTime: number; zoneId: number }` / `getRaidReports(c, zoneIds: Set<number>, maxPages?): Promise<RaidReportRef[]>`
  - `export interface WipePull { encounterId: number; fightId: number; fightPercentage: number; players: string[] }` / `getReportWipes(code): Promise<WipePull[]>`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/warcraftlogsIntel.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../src/services/httpClient.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/httpClient.js')>();
  return { ...actual, httpRequest: vi.fn() };
});

vi.mock('../../src/config.js', () => ({
  config: {
    warcraftLogsClientId: 'id',
    warcraftLogsClientSecret: 'secret',
    warcraftLogsGuildId: '1',
  },
}));

import { httpRequest } from '../../src/services/httpClient.js';
import {
  getZoneKills,
  getEncounterKills,
  getReportWipes,
  WclPointsExhausted,
} from '../../src/services/warcraftlogs.js';

const mocked = vi.mocked(httpRequest);
const character = { region: 'eu', realm: 'draenor', name: 'Brenthunter' };
const token = { access_token: 'tok', expires_in: 3600 };

beforeEach(() => mocked.mockReset());
afterEach(() => vi.restoreAllMocks());

describe('getZoneKills', () => {
  it('returns encounter ids with kill counts, dropping zero-kill bosses', async () => {
    mocked.mockResolvedValueOnce(token as never).mockResolvedValueOnce({
      data: {
        characterData: {
          character: {
            zoneRankings: {
              rankings: [
                { encounter: { id: 3135, name: 'Dimensius' }, totalKills: 5 },
                { encounter: { id: 3131, name: "Loom'ithar" }, totalKills: 0 },
              ],
            },
          },
        },
        rateLimitData: { limitPerHour: 9000, pointsSpentThisHour: 10 },
      },
    } as never);

    expect(await getZoneKills(character, 44)).toEqual([{ encounterId: 3135, totalKills: 5 }]);
  });

  it('throws WclPointsExhausted when the hourly budget is nearly spent', async () => {
    mocked.mockResolvedValueOnce(token as never).mockResolvedValueOnce({
      data: {
        characterData: { character: { zoneRankings: { rankings: [] } } },
        rateLimitData: { limitPerHour: 9000, pointsSpentThisHour: 8500 },
      },
    } as never);

    await expect(getZoneKills(character, 44)).rejects.toBeInstanceOf(WclPointsExhausted);
  });

  it('returns an empty array when the character is unknown to WCL', async () => {
    mocked
      .mockResolvedValueOnce(token as never)
      .mockResolvedValueOnce({ data: { characterData: { character: null } } } as never);
    expect(await getZoneKills(character, 44)).toEqual([]);
  });
});

describe('getEncounterKills', () => {
  it("returns the character's own kills sorted oldest first", async () => {
    mocked.mockResolvedValueOnce(token as never).mockResolvedValueOnce({
      data: {
        characterData: {
          character: {
            encounterRankings: {
              ranks: [
                { startTime: 200, report: { code: 'later' } },
                { startTime: 100, report: { code: 'first' } },
              ],
            },
          },
        },
      },
    } as never);

    expect((await getEncounterKills(character, 3135)).map((k) => k.reportCode)).toEqual([
      'first',
      'later',
    ]);
  });

  it('returns an empty array when the kill predates WCL rankings', async () => {
    mocked.mockResolvedValueOnce(token as never).mockResolvedValueOnce({
      data: { characterData: { character: { encounterRankings: { ranks: [] } } } },
    } as never);
    expect(await getEncounterKills(character, 3135)).toEqual([]);
  });
});

describe('getReportWipes', () => {
  it('resolves per-pull rosters from friendlyPlayers and masterData, skipping kills', async () => {
    mocked.mockResolvedValueOnce(token as never).mockResolvedValueOnce({
      data: {
        reportData: {
          report: {
            masterData: {
              actors: [
                { id: 11, name: 'Brentprietwo' },
                { id: 184, name: 'Brenthunter' },
              ],
            },
            fights: [
              {
                id: 6,
                encounterID: 3181,
                kill: false,
                fightPercentage: 12.5,
                friendlyPlayers: [11],
              },
              { id: 7, encounterID: 3181, kill: true, fightPercentage: 0, friendlyPlayers: [184] },
            ],
          },
        },
      },
    } as never);

    expect(await getReportWipes('abc')).toEqual([
      { encounterId: 3181, fightId: 6, fightPercentage: 12.5, players: ['Brentprietwo'] },
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/warcraftlogsIntel.test.ts`
Expected: FAIL — the new exports do not exist

- [ ] **Step 3: Implement**

Append to `src/services/warcraftlogs.ts`:

```typescript
import { shouldPreemptWclPoints } from '../functions/applications/intel/rateLimit.js';
import type { RaiderIoCharacter } from '../functions/applications/raiderIoName.js';

/** Thrown before WCL refuses us, so the job pauses on our terms. */
export class WclPointsExhausted extends Error {
  readonly service = 'warcraftlogs' as const;
  constructor(spent: number, limit: number) {
    super(`WarcraftLogs points nearly exhausted: ${spent}/${limit} this hour`);
    this.name = 'WclPointsExhausted';
  }
}

interface RateLimitEnvelope {
  rateLimitData?: { limitPerHour: number; pointsSpentThisHour: number };
}

async function query<T extends RateLimitEnvelope>(
  gql: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const token = await getAccessToken();
  const result = await httpRequest<{ data: T }>(
    'warcraftlogs',
    'https://www.warcraftlogs.com/api/v2/client',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: gql, variables }),
    },
  );
  const rl = result.data.rateLimitData;
  if (rl && shouldPreemptWclPoints(rl.pointsSpentThisHour, rl.limitPerHour)) {
    throw new WclPointsExhausted(rl.pointsSpentThisHour, rl.limitPerHour);
  }
  return result.data;
}

export interface ZoneKill {
  encounterId: number;
  totalKills: number;
}

const ZONE_KILLS_QUERY = `
  query zoneKills($name: String!, $realm: String!, $region: String!, $zone: Int!) {
    characterData {
      character(name: $name, serverSlug: $realm, serverRegion: $region) {
        zoneRankings(zoneID: $zone, difficulty: 5, metric: dps)
      }
    }
    rateLimitData { limitPerHour pointsSpentThisHour }
  }
`;

/**
 * Which bosses this character killed in a zone, keyed on WCL encounter ids.
 * The structural source of truth: it decides "killed or not", so no
 * cross-source name matching can ever drop a boss.
 */
export async function getZoneKills(c: RaiderIoCharacter, zoneId: number): Promise<ZoneKill[]> {
  const data = await query<
    RateLimitEnvelope & {
      characterData: {
        character: {
          zoneRankings?: { rankings?: { encounter?: { id: number }; totalKills?: number }[] };
        } | null;
      };
    }
  >(ZONE_KILLS_QUERY, {
    name: c.name,
    realm: c.realm,
    region: c.region.toUpperCase(),
    zone: zoneId,
  });

  return (data.characterData.character?.zoneRankings?.rankings ?? [])
    .filter((r) => (r.totalKills ?? 0) > 0 && r.encounter?.id)
    .map((r) => ({ encounterId: r.encounter!.id, totalKills: r.totalKills! }));
}

export interface EncounterKill {
  reportCode: string;
  startTime: number;
}

const ENCOUNTER_KILLS_QUERY = `
  query encounterKills($name: String!, $realm: String!, $region: String!, $encounter: Int!) {
    characterData {
      character(name: $name, serverSlug: $realm, serverRegion: $region) {
        encounterRankings(encounterID: $encounter, difficulty: 5, metric: dps)
      }
    }
    rateLimitData { limitPerHour pointsSpentThisHour }
  }
`;

/** This character's own kills of one boss, oldest first — index 0 is their
 *  first kill, and each entry carries the report to link. */
export async function getEncounterKills(
  c: RaiderIoCharacter,
  encounterId: number,
): Promise<EncounterKill[]> {
  const data = await query<
    RateLimitEnvelope & {
      characterData: {
        character: {
          encounterRankings?: { ranks?: { startTime: number; report?: { code: string } }[] };
        } | null;
      };
    }
  >(ENCOUNTER_KILLS_QUERY, {
    name: c.name,
    realm: c.realm,
    region: c.region.toUpperCase(),
    encounter: encounterId,
  });

  return (data.characterData.character?.encounterRankings?.ranks ?? [])
    .filter((r) => r.report?.code)
    .map((r) => ({ reportCode: r.report!.code, startTime: r.startTime }))
    .sort((a, b) => a.startTime - b.startTime);
}

export interface RaidReportRef {
  code: string;
  startTime: number;
  zoneId: number;
}

const RECENT_REPORTS_QUERY = `
  query recentReports($name: String!, $realm: String!, $region: String!, $page: Int!) {
    characterData {
      character(name: $name, serverSlug: $realm, serverRegion: $region) {
        recentReports(limit: 100, page: $page) {
          has_more_pages
          data { code startTime zone { id } }
        }
      }
    }
    rateLimitData { limitPerHour pointsSpentThisHour }
  }
`;

/** Reports this character appears in that belong to one of `zoneIds`. Presence
 *  in a report proves nothing about a given pull — see getReportWipes. */
export async function getRaidReports(
  c: RaiderIoCharacter,
  zoneIds: Set<number>,
  maxPages = 6,
): Promise<RaidReportRef[]> {
  const out: RaidReportRef[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const data = await query<
      RateLimitEnvelope & {
        characterData: {
          character: {
            recentReports?: {
              has_more_pages: boolean;
              data: { code: string; startTime: number; zone?: { id: number } }[];
            };
          } | null;
        };
      }
    >(RECENT_REPORTS_QUERY, {
      name: c.name,
      realm: c.realm,
      region: c.region.toUpperCase(),
      page,
    });

    const reports = data.characterData.character?.recentReports;
    if (!reports) break;
    for (const r of reports.data) {
      if (r.zone?.id && zoneIds.has(r.zone.id)) {
        out.push({ code: r.code, startTime: r.startTime, zoneId: r.zone.id });
      }
    }
    if (!reports.has_more_pages) break;
  }
  return out;
}

export interface WipePull {
  encounterId: number;
  fightId: number;
  fightPercentage: number;
  players: string[];
}

const REPORT_WIPES_QUERY = `
  query reportWipes($code: String!) {
    reportData {
      report(code: $code) {
        masterData { actors(type: "Player") { id name } }
        fights(killType: All, difficulty: 5) {
          id
          encounterID
          kill
          fightPercentage
          friendlyPlayers
        }
      }
    }
    rateLimitData { limitPerHour pointsSpentThisHour }
  }
`;

/**
 * Every wipe pull in a report with the names of who was actually in it.
 * `friendlyPlayers` + `masterData.actors` gives per-pull rosters in ONE query;
 * `playerDetails` answers the same question one pull at a time, and a single
 * boss can have 40+ pulls in a night.
 */
export async function getReportWipes(code: string): Promise<WipePull[]> {
  const data = await query<
    RateLimitEnvelope & {
      reportData: {
        report: {
          masterData?: { actors?: { id: number; name: string }[] };
          fights?: {
            id: number;
            encounterID: number;
            kill: boolean;
            fightPercentage?: number;
            friendlyPlayers?: number[];
          }[];
        } | null;
      };
    }
  >(REPORT_WIPES_QUERY, { code });

  const report = data.reportData.report;
  if (!report) return [];
  const byId = new Map((report.masterData?.actors ?? []).map((a) => [a.id, a.name]));

  return (report.fights ?? [])
    .filter((f) => !f.kill)
    .map((f) => ({
      encounterId: f.encounterID,
      fightId: f.id,
      fightPercentage: f.fightPercentage ?? 100,
      players: (f.friendlyPlayers ?? [])
        .map((id) => byId.get(id))
        .filter((n): n is string => Boolean(n)),
    }));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/warcraftlogsIntel.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/services/warcraftlogs.ts tests/unit/warcraftlogsIntel.test.ts
git add src/services/warcraftlogs.ts tests/unit/warcraftlogsIntel.test.ts
git commit -m "feat(logs): add per-character WCL kill, report and wipe queries"
```

---

### Task 8: Raider.IO documented-API additions

**Files:**

- Modify: `src/services/raiderio.ts`
- Test: `tests/unit/raiderioIntel.test.ts`

**Interfaces:**

- Consumes: existing `BASE_URL` and `httpRequest` in `raiderio.ts`; `RaiderIoCharacter`; `getCachedOrFetch` and `ttl` from `src/services/apiCache.ts`
- Produces:
  - `export interface CharacterGuild { name: string; realm: string }`
  - `export interface CharacterSummary { className: string | null; guild: CharacterGuild | null }`
  - `export interface FullRosterMember { name: string; realm: string; className: string | null }`
  - `getCharacterGuild(c): Promise<CharacterGuild | null>`
  - `getCharacterSummary(c): Promise<CharacterSummary | null>`
  - `getMythicKillCount(c): Promise<number>`
  - `getFullGuildRoster(name: string, realm: string): Promise<FullRosterMember[]>`
  - `GUILD_ROSTER_TTL_MS`

**Why `getFullGuildRoster` is a new function and not a widened `getGuildRoster`.** The existing `getGuildRoster()` hardcodes our own guild _and_ filters to `ROSTER_RANKS = [0, 1, 3, 4, 5, 7]`. Both are correct for the raider auto-match, and both are wrong here:

- Guild ranks are per-guild labels with no shared meaning. Applying our rank filter to a stranger's guild drops arbitrary members — reintroducing exactly the false negative the spec's "rosters are scanned in full" rule exists to prevent, and doing it invisibly.
- The sweep needs every member, so this function must not filter at all.

Widening the existing function would put a footgun behind a default argument. Keep them separate; `getGuildRoster()` is untouched.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/raiderioIntel.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../src/services/httpClient.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/httpClient.js')>();
  return { ...actual, httpRequest: vi.fn() };
});

import { httpRequest, HttpError } from '../../src/services/httpClient.js';
import { closeDatabase, getDatabase } from '../../src/database/db.js';
import { createTables } from '../../src/database/schema.js';
import {
  getCharacterGuild,
  getCharacterSummary,
  getMythicKillCount,
  getFullGuildRoster,
} from '../../src/services/raiderio.js';

const mocked = vi.mocked(httpRequest);
const character = { region: 'eu', realm: 'argent-dawn', name: 'Driptinus' };

beforeEach(() => mocked.mockReset());

describe('getCharacterGuild', () => {
  it("returns the guild's own realm, not the character's", async () => {
    mocked.mockResolvedValueOnce({
      name: 'Driptinus',
      guild: { name: 'Rancour', realm: 'Draenor' },
    } as never);
    expect(await getCharacterGuild(character)).toEqual({ name: 'Rancour', realm: 'Draenor' });
  });

  it('returns null for a guildless character', async () => {
    mocked.mockResolvedValueOnce({ name: 'Driptinus' } as never);
    expect(await getCharacterGuild(character)).toBeNull();
  });

  it('returns null when Raider.IO 404s the character', async () => {
    mocked.mockRejectedValueOnce(
      new HttpError({ service: 'raiderio', status: 404, attempts: 1, message: 'not found' }),
    );
    expect(await getCharacterGuild(character)).toBeNull();
  });
});

describe('getCharacterSummary', () => {
  it('returns class and guild together', async () => {
    mocked.mockResolvedValueOnce({
      name: 'Driptinus',
      class: 'Shaman',
      guild: { name: 'Rancour', realm: 'Draenor' },
    } as never);
    expect(await getCharacterSummary(character)).toEqual({
      className: 'Shaman',
      guild: { name: 'Rancour', realm: 'Draenor' },
    });
  });
});

describe('getMythicKillCount', () => {
  it('sums mythic_bosses_killed across raids', async () => {
    mocked.mockResolvedValueOnce({
      raid_progression: {
        'tier-mn-1': { mythic_bosses_killed: 7, total_bosses: 9 },
        sporefall: { mythic_bosses_killed: 1, total_bosses: 1 },
      },
    } as never);
    expect(await getMythicKillCount(character)).toBe(8);
  });

  it('returns 0 rather than throwing when the lookup fails', async () => {
    mocked.mockRejectedValueOnce(
      new HttpError({ service: 'raiderio', status: 500, attempts: 3, message: 'boom' }),
    );
    expect(await getMythicKillCount(character)).toBe(0);
  });
});

describe('getFullGuildRoster', () => {
  /** Rank 8 is outside ROSTER_RANKS and must still be returned. */
  const members = [
    {
      rank: 0,
      character: { name: 'Driptinus', realm: 'Argent Dawn', region: 'eu', class: 'Monk' },
    },
    { rank: 8, character: { name: 'Boptinus', realm: 'Tarren Mill', region: 'eu', class: 'Mage' } },
  ];

  beforeEach(() => createTables(getDatabase(':memory:')));
  afterEach(() => closeDatabase());

  it('returns every member, including ranks the own-guild roster filters out', async () => {
    mocked.mockResolvedValueOnce({ members } as never);
    const roster = await getFullGuildRoster('Rancour', 'Draenor');
    expect(roster.map((m) => m.name)).toEqual(['Driptinus', 'Boptinus']);
    expect(roster[1]).toEqual({ name: 'Boptinus', realm: 'Tarren Mill', className: 'Mage' });
  });

  it("slugifies the guild's realm", async () => {
    mocked.mockResolvedValueOnce({ members: [] } as never);
    await getFullGuildRoster('Rancour', 'Argent Dawn');
    expect(mocked.mock.calls[0]![1]).toContain('realm=argent-dawn');
  });

  it('serves a second request for the same guild from the cache', async () => {
    mocked.mockResolvedValueOnce({ members } as never);
    await getFullGuildRoster('Rancour', 'Draenor');
    await getFullGuildRoster('rancour', 'draenor');
    expect(mocked).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failure as an empty guild', async () => {
    mocked.mockRejectedValueOnce(
      new HttpError({ service: 'raiderio', status: 500, attempts: 3, message: 'boom' }),
    );
    expect(await getFullGuildRoster('Rancour', 'Draenor')).toEqual([]);

    mocked.mockResolvedValueOnce({ members } as never);
    expect(await getFullGuildRoster('Rancour', 'Draenor')).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/raiderioIntel.test.ts`
Expected: FAIL — exports missing

- [ ] **Step 3: Implement**

Append to `src/services/raiderio.ts`, reusing the file's existing `BASE_URL`:

```typescript
import type { RaiderIoCharacter } from '../functions/applications/raiderIoName.js';

export interface CharacterGuild {
  name: string;
  realm: string;
}

export interface CharacterSummary {
  className: string | null;
  guild: CharacterGuild | null;
}

interface ProfileResponse {
  class?: string;
  guild?: { name: string; realm: string };
  raid_progression?: Record<string, { mythic_bosses_killed?: number }>;
}

function profileUrl(c: RaiderIoCharacter, fields: string): string {
  return (
    `${BASE_URL}/characters/profile?region=${encodeURIComponent(c.region)}` +
    `&realm=${encodeURIComponent(c.realm)}&name=${encodeURIComponent(c.name)}&fields=${fields}`
  );
}

/**
 * The guild carries its OWN realm, frequently not the character's:
 * Driptinus-Argent Dawn is in Rancour-Draenor, and querying the roster on the
 * character's realm returns "Could not find requested guild".
 */
export async function getCharacterGuild(c: RaiderIoCharacter): Promise<CharacterGuild | null> {
  try {
    const data = await httpRequest<ProfileResponse>('raiderio', profileUrl(c, 'guild'));
    return data.guild ? { name: data.guild.name, realm: data.guild.realm } : null;
  } catch {
    return null;
  }
}

export async function getCharacterSummary(c: RaiderIoCharacter): Promise<CharacterSummary | null> {
  try {
    const data = await httpRequest<ProfileResponse>('raiderio', profileUrl(c, 'guild'));
    return {
      className: data.class ?? null,
      guild: data.guild ? { name: data.guild.name, realm: data.guild.realm } : null,
    };
  } catch {
    return null;
  }
}

/**
 * Mythic bosses killed in the CURRENT expansion — a cheap prioritiser for which
 * alts deserve a WCL sweep. It cannot gate the sweep: the field covers one
 * expansion, lags the crawl, and counts kills but not wipe progress.
 */
export async function getMythicKillCount(c: RaiderIoCharacter): Promise<number> {
  try {
    const data = await httpRequest<ProfileResponse>('raiderio', profileUrl(c, 'raid_progression'));
    return Object.values(data.raid_progression ?? {}).reduce(
      (sum, raid) => sum + (raid.mythic_bosses_killed ?? 0),
      0,
    );
  } catch {
    return 0;
  }
}

export interface FullRosterMember {
  name: string;
  realm: string;
  className: string | null;
}

/** Rosters change slowly, and a stale member costs one wasted fingerprint. */
export const GUILD_ROSTER_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Realm slug for a guild's own realm: lowercased, spaces to hyphens
 * ("Argent Dawn" -> "argent-dawn"). Apostrophes are dropped, which covers
 * every EU/US realm currently in use.
 */
function realmSlug(realm: string): string {
  return realm.toLowerCase().replace(/'/g, '').replace(/\s+/g, '-');
}

/**
 * EVERY member of an arbitrary guild, unfiltered and cached by `name-realm`.
 *
 * Deliberately NOT the existing `getGuildRoster()`, which is hardcoded to our
 * own guild and filters to ROSTER_RANKS. Guild ranks mean different things in
 * different guilds, so filtering a stranger's roster by our rank list silently
 * drops members — the spec requires full rosters because the one genuine alt in
 * the 429-member `Goodlife` sample sat well beyond the first 50.
 *
 * The realm MUST be the guild's own realm, not the character's: Driptinus-Argent
 * Dawn is in Rancour-Draenor, and the character's realm returns
 * "Could not find requested guild".
 *
 * Cached by entity, so overlapping guilds across applicants cost one fetch.
 *
 * The fetcher THROWS on failure rather than returning [] — `getCachedOrFetch`
 * stores whatever the fetcher returns, so an empty array returned from inside it
 * would cache a transient 500 as "this guild has no members" for a full day. The
 * catch sits outside the cache call, so a failure yields [] for this sweep only
 * and is retried next time.
 */
export async function getFullGuildRoster(name: string, realm: string): Promise<FullRosterMember[]> {
  const key = `guild-roster:${realmSlug(realm)}:${name.toLowerCase()}`;
  const url =
    `${BASE_URL}/guilds/profile?region=eu&realm=${encodeURIComponent(realmSlug(realm))}` +
    `&name=${encodeURIComponent(name)}&fields=members`;
  try {
    return await getCachedOrFetch<FullRosterMember[]>(key, ttl(GUILD_ROSTER_TTL_MS), async () => {
      const data = await httpRequest<{ members: RaiderIoMember[] }>('raiderio', url);
      return data.members.map((m) => ({
        name: m.character.name,
        realm: m.character.realm,
        className: m.character.class ?? null,
      }));
    });
  } catch {
    return [];
  }
}
```

Add the cache import at the top of `raiderio.ts`:

```typescript
import { getCachedOrFetch, ttl } from './apiCache.js';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/raiderioIntel.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/services/raiderio.ts tests/unit/raiderioIntel.test.ts
git add src/services/raiderio.ts tests/unit/raiderioIntel.test.ts
git commit -m "feat(intel): add Raider.IO guild, summary and Mythic-kill lookups"
```

---

### Task 9: Raider.IO internal endpoints (owner, claimed characters, kill dates)

**Files:**

- Create: `src/services/raiderioInternal.ts`
- Test: `tests/unit/raiderioInternal.test.ts`

**Interfaces:**

- Consumes: `httpRequest` with service `'raiderio-internal'` (Task 3), `RaiderIoCharacter`
- Produces:
  - `export interface CharacterOwner { user: string | null; discordProfile: string | null; declaredMain: RaiderIoCharacter | null }`
  - `getCharacterOwner(c): Promise<CharacterOwner | null>`
  - `export interface ClaimedCharacter { name: string; realm: string; className: string | null; level: number | null }`
  - `getClaimedCharacters(user: string): Promise<ClaimedCharacter[]>`
  - `export interface MythicKillDate { bossName: string; firstDefeated: string }`
  - `getMythicKillDates(c, tierOrdinals: number[]): Promise<MythicKillDate[] | null>` — `null` means **unknown** (fetch failed), never "no kills"
  - `export const RAIDERIO_INTERNAL_PACE_MS = 700`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/raiderioInternal.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/services/httpClient.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/httpClient.js')>();
  return { ...actual, httpRequest: vi.fn() };
});

import { httpRequest, HttpError } from '../../src/services/httpClient.js';
import {
  getCharacterOwner,
  getClaimedCharacters,
  getMythicKillDates,
} from '../../src/services/raiderioInternal.js';

const mocked = vi.mocked(httpRequest);
const character = { region: 'eu', realm: 'silvermoon', name: 'Yawnersw' };

beforeEach(() => mocked.mockReset());

describe('getCharacterOwner', () => {
  it('returns the owning user, discord handle and declared main', async () => {
    mocked.mockResolvedValueOnce({
      characterDetails: {
        user: { name: 'binded' },
        characterCustomizations: {
          isClaimed: true,
          discord_profile: 'binded',
          main_character: {
            name: 'Yawnersowo',
            realm: { slug: 'draenor' },
            path: '/characters/eu/draenor/Yawnersowo',
          },
        },
      },
    } as never);

    expect(await getCharacterOwner(character)).toEqual({
      user: 'binded',
      discordProfile: 'binded',
      declaredMain: { region: 'eu', realm: 'draenor', name: 'Yawnersowo' },
    });
  });

  it('returns a null user when privacy hides it but still reports discord', async () => {
    mocked.mockResolvedValueOnce({
      characterDetails: {
        user: null,
        characterCustomizations: { isClaimed: true, discord_profile: 'ictinus' },
      },
    } as never);

    expect(await getCharacterOwner(character)).toEqual({
      user: null,
      discordProfile: 'ictinus',
      declaredMain: null,
    });
  });

  it('returns null when the internal endpoint fails', async () => {
    mocked.mockRejectedValueOnce(
      new HttpError({ service: 'raiderio-internal', status: 500, attempts: 1, message: 'boom' }),
    );
    expect(await getCharacterOwner(character)).toBeNull();
  });
});

describe('getClaimedCharacters', () => {
  it('maps the claimed character list', async () => {
    mocked.mockResolvedValueOnce({
      viewUserCharactersApi: {
        name: 'Zenfu',
        characters: [
          {
            character: {
              name: 'Gorre',
              level: 90,
              class: { name: 'Death Knight' },
              realm: { name: 'Outland' },
            },
          },
        ],
      },
    } as never);

    expect(await getClaimedCharacters('Zenfu')).toEqual([
      { name: 'Gorre', realm: 'Outland', className: 'Death Knight', level: 90 },
    ]);
  });

  it('returns an empty array for an unknown user', async () => {
    mocked.mockResolvedValueOnce({} as never);
    expect(await getClaimedCharacters('nobody')).toEqual([]);
  });
});

describe('getMythicKillDates', () => {
  it('carries the guild each kill happened with, for guild history', async () => {
    mocked.mockResolvedValueOnce({
      characterRaidProgress: {
        raidProgress: [
          {
            raid: 'tier-mn-1',
            encountersDefeated: {
              mythic: [
                {
                  slug: 'imperator-averzian',
                  firstDefeated: '2026-04-23T19:00:00.000Z',
                  guild: { name: 'Hindsight', realm: { slug: 'kazzak' } },
                },
              ],
            },
          },
        ],
      },
    } as never);

    const dates = await getMythicKillDates(character, [35]);
    expect(dates?.[0].guild).toEqual({ name: 'Hindsight', realm: 'kazzak' });
  });

  it('flattens encountersDefeated across the requested tiers', async () => {
    mocked
      .mockResolvedValueOnce({
        characterRaidProgress: {
          raidProgress: [
            {
              raid: 'tier-mn-1',
              encountersDefeated: {
                mythic: [
                  { slug: 'crown-of-the-cosmos', firstDefeated: '2026-04-23T19:00:00.000Z' },
                ],
              },
            },
          ],
        },
      } as never)
      .mockResolvedValueOnce({
        characterRaidProgress: {
          raidProgress: [
            {
              raid: 'manaforge-omega',
              encountersDefeated: {
                mythic: [{ slug: 'dimensius', firstDefeated: '2025-10-30T20:00:00.000Z' }],
              },
            },
          ],
        },
      } as never);

    const dates = await getMythicKillDates(character, [35, 34]);
    expect(dates).toEqual([
      { bossName: 'crown-of-the-cosmos', firstDefeated: '2026-04-23T19:00:00.000Z', guild: null },
      { bossName: 'dimensius', firstDefeated: '2025-10-30T20:00:00.000Z', guild: null },
    ]);
  });

  it('returns null (unknown), never an empty list, when a tier fetch fails', async () => {
    mocked.mockRejectedValueOnce(
      new HttpError({ service: 'raiderio-internal', status: 503, attempts: 1, message: 'nope' }),
    );
    expect(await getMythicKillDates(character, [35])).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/raiderioInternal.test.ts`
Expected: FAIL — cannot resolve the module

- [ ] **Step 3: Implement**

Create `src/services/raiderioInternal.ts`:

```typescript
import { httpRequest } from './httpClient.js';
import { logger } from './logger.js';
import type { RaiderIoCharacter } from '../functions/applications/raiderIoName.js';

/**
 * Raider.IO's *internal* API — the endpoints its own site calls. These are
 * undocumented and may change without notice, so everything here fails soft and
 * uses its own apiHealth service key: a break must never open the circuit for
 * the documented API that getGuildRoster and the achievements image depend on.
 */
const SITE = 'https://raider.io';
const SERVICE = 'raiderio-internal' as const;

/** Calling these back-to-back drops payloads silently — an unpaced sweep once
 *  lost a character's kill data and reassigned five first kills to the wrong
 *  character. Callers pace their loops by this. */
export const RAIDERIO_INTERNAL_PACE_MS = 700;

export interface CharacterOwner {
  user: string | null;
  discordProfile: string | null;
  declaredMain: RaiderIoCharacter | null;
}

interface CharacterDetailsResponse {
  characterDetails?: {
    user?: { name?: string } | null;
    characterCustomizations?: {
      isClaimed?: boolean;
      discord_profile?: string | null;
      main_character?: { name?: string; path?: string; realm?: { slug?: string } } | null;
    };
  };
}

function mainFromPath(main: {
  name?: string;
  path?: string;
  realm?: { slug?: string };
}): RaiderIoCharacter | null {
  if (!main.name) return null;
  const fromPath = main.path?.match(/\/characters\/([^/]+)\/([^/]+)\/([^/?#]+)/i);
  const region = fromPath?.[1]?.toLowerCase() ?? 'eu';
  const realm = (main.realm?.slug ?? fromPath?.[2] ?? '').toLowerCase();
  if (!realm) return null;
  return { region, realm, name: main.name };
}

export async function getCharacterOwner(c: RaiderIoCharacter): Promise<CharacterOwner | null> {
  const url = `${SITE}/api/characters/${encodeURIComponent(c.region)}/${encodeURIComponent(
    c.realm,
  )}/${encodeURIComponent(c.name)}`;
  try {
    const data = await httpRequest<CharacterDetailsResponse>(SERVICE, url);
    const details = data.characterDetails;
    if (!details) return null;
    const custom = details.characterCustomizations ?? {};
    return {
      user: details.user?.name ?? null,
      discordProfile: custom.discord_profile ?? null,
      declaredMain: custom.main_character ? mainFromPath(custom.main_character) : null,
    };
  } catch (error) {
    logger.warn('RaiderIOInternal', `Owner lookup failed for ${c.name}-${c.realm}: ${error}`);
    return null;
  }
}

export interface ClaimedCharacter {
  name: string;
  realm: string;
  className: string | null;
  level: number | null;
}

interface ViewCharactersResponse {
  viewUserCharactersApi?: {
    characters?: {
      character?: {
        name?: string;
        level?: number;
        class?: { name?: string };
        realm?: { name?: string };
      };
    }[];
  };
}

export async function getClaimedCharacters(user: string): Promise<ClaimedCharacter[]> {
  const url = `${SITE}/api/user/view-characters?name=${encodeURIComponent(user)}`;
  try {
    const data = await httpRequest<ViewCharactersResponse>(SERVICE, url);
    const list = data.viewUserCharactersApi?.characters ?? [];
    return list
      .map((entry) => entry.character)
      .filter((ch): ch is NonNullable<typeof ch> => Boolean(ch?.name && ch.realm?.name))
      .map((ch) => ({
        name: ch.name!,
        realm: ch.realm!.name!,
        className: ch.class?.name ?? null,
        level: ch.level ?? null,
      }));
  } catch (error) {
    logger.warn('RaiderIOInternal', `Claimed characters failed for "${user}": ${error}`);
    return [];
  }
}

export interface MythicKillDate {
  /** Raider.IO's boss slug, matched to a WCL encounter name by the caller. */
  bossName: string;
  firstDefeated: string;
  /** The guild this kill happened with — dated guild history, free of charge. */
  guild: { name: string; realm: string } | null;
}

interface RaidProgressResponse {
  characterRaidProgress?: {
    raidProgress?: {
      raid?: string;
      encountersDefeated?: {
        mythic?: {
          slug?: string;
          firstDefeated?: string;
          guild?: { name?: string; realm?: { slug?: string; name?: string } };
        }[];
      };
    }[];
  };
}

/**
 * First-kill dates per boss across the given tier ordinals. Returns `null` when
 * ANY tier fetch fails: an empty list would read as "this character killed
 * nothing", which silently moves first-kill credit to another character.
 */
export async function getMythicKillDates(
  c: RaiderIoCharacter,
  tierOrdinals: number[],
): Promise<MythicKillDate[] | null> {
  const out: MythicKillDate[] = [];
  for (const tier of tierOrdinals) {
    const url =
      `${SITE}/api/characters/${encodeURIComponent(c.region)}/${encodeURIComponent(c.realm)}/` +
      `${encodeURIComponent(c.name)}/raid-progress?tier=${tier}`;
    try {
      const data = await httpRequest<RaidProgressResponse>(SERVICE, url);
      for (const raid of data.characterRaidProgress?.raidProgress ?? []) {
        for (const e of raid.encountersDefeated?.mythic ?? []) {
          if (!e.slug || !e.firstDefeated) continue;
          const guildRealm = e.guild?.realm?.slug ?? e.guild?.realm?.name ?? null;
          out.push({
            bossName: e.slug,
            firstDefeated: e.firstDefeated,
            guild: e.guild?.name && guildRealm ? { name: e.guild.name, realm: guildRealm } : null,
          });
        }
      }
    } catch (error) {
      logger.warn(
        'RaiderIOInternal',
        `Kill dates unknown for ${c.name}-${c.realm} tier ${tier}: ${error}`,
      );
      return null;
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/raiderioInternal.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/services/raiderioInternal.ts tests/unit/raiderioInternal.test.ts
git add src/services/raiderioInternal.ts tests/unit/raiderioInternal.test.ts
git commit -m "feat(intel): add Raider.IO internal owner, claimed and kill-date lookups"
```

---

### Task 10: Blizzard achievement fingerprint and comparison

**Files:**

- Create: `src/functions/applications/alts/compareFingerprints.ts` (pure)
- Modify: `src/services/blizzard.ts`
- Modify: `src/services/apiCache.ts` (add `pruneCache`)
- Test: `tests/unit/compareFingerprints.test.ts`
- Test: `tests/unit/blizzardFingerprint.test.ts`

**Interfaces:**

- Consumes: existing `getAccessToken`, `httpRequest` and `normalizeRealmSlug` inside `blizzard.ts`; `getCachedOrFetch` and `ttl` from `apiCache.ts`; `HttpError` and `CircuitOpenError` from `httpClient.ts`
- Produces:
  - `export type Fingerprint = Map<number, number>` (achievement id → completed timestamp)
  - `export interface FingerprintMatch { identical: number; common: number; percent: number; isMatch: boolean }`
  - `compareFingerprints(a: Fingerprint, b: Fingerprint): FingerprintMatch`
  - `MATCH_PERCENT_THRESHOLD = 20`, `MIN_COMMON_ACHIEVEMENTS = 200`
  - `getCharacterFingerprint(c: RaiderIoCharacter): Promise<Fingerprint | null>` in `blizzard.ts` (`null` = unavailable, not "no match")
  - `FINGERPRINT_TTL_MS` in `blizzard.ts`
  - `pruneCache(prefix: string, olderThanMs: number): number` in `apiCache.ts`

**The fingerprint is cached per character, and this is what makes the feature affordable.** A fingerprint depends only on the character, so it is the same answer whoever asked. Applicants share guilds — a second applicant from `Rancour` re-walks a roster already fingerprinted — so an entity-keyed cache turns a 3,000-request sweep into a few hundred. It is also the single expensive call in the whole design, at roughly 300 requests per second of wall clock under the concurrency limiter.

**Two failure contracts must not be conflated:**

| Error                                            | Behaviour                      | Why                                                                                                                                                                                                       |
| ------------------------------------------------ | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 429, or an open circuit                          | **rethrow**                    | The runner pauses and resumes on these. Swallowing them turns a rate limit into "this account has no alts" and silently empties the sweep — the exact failure the resumable-job design exists to prevent. |
| 404, 403, 500, character below achievement floor | **return `null`** (not cached) | Genuinely unavailable. `null` already means "unknown, not a non-match" to `discoverAlts`.                                                                                                                 |

This also fixes a live contradiction in the plan: the doc comment on `getCharacterFingerprint` promises `null` on failure while the body lets `httpRequest` throw, and `discoverAlts` calls it unguarded for the applicant's own character (`const applicantFingerprint = await deps.getCharacterFingerprint(primary)` — it null-checks but does not catch). A renamed or transferred applicant character would 404 and fail the phase instead of skipping the sweep. Honouring the documented contract here fixes it at the source; the roster loop's existing `.catch(() => null)` stays as it is.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/compareFingerprints.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  compareFingerprints,
  MATCH_PERCENT_THRESHOLD,
  MIN_COMMON_ACHIEVEMENTS,
  type Fingerprint,
} from '../../src/functions/applications/alts/compareFingerprints.js';

/** `identical` achievements share a timestamp; `differing` overlap by id only. */
function build(identical: number, differing: number, offset = 0): [Fingerprint, Fingerprint] {
  const a: Fingerprint = new Map();
  const b: Fingerprint = new Map();
  for (let i = 0; i < identical; i++) {
    a.set(i, 1_700_000_000_000 + i);
    b.set(i, 1_700_000_000_000 + i);
  }
  for (let i = 0; i < differing; i++) {
    const id = 100_000 + i;
    a.set(id, 1_700_000_000_000 + i);
    b.set(id, 1_800_000_000_000 + i + offset);
  }
  return [a, b];
}

describe('compareFingerprints', () => {
  it('reports a same-account pair as a match', () => {
    const [a, b] = build(2069, 2531);
    const result = compareFingerprints(a, b);
    expect(result.identical).toBe(2069);
    expect(result.common).toBe(4600);
    expect(result.percent).toBeCloseTo(44.98, 1);
    expect(result.isMatch).toBe(true);
  });

  it('rejects unrelated characters at the observed noise level', () => {
    const [a, b] = build(83, 2647);
    const result = compareFingerprints(a, b);
    expect(result.percent).toBeLessThan(4);
    expect(result.isMatch).toBe(false);
  });

  it('accepts the weakest genuine match observed (31%)', () => {
    const [a, b] = build(310, 690);
    expect(compareFingerprints(a, b).isMatch).toBe(true);
  });

  it('refuses to judge below the common-achievement floor', () => {
    const [a, b] = build(150, 0);
    const result = compareFingerprints(a, b);
    expect(result.common).toBeLessThan(MIN_COMMON_ACHIEVEMENTS);
    expect(result.percent).toBe(100);
    expect(result.isMatch).toBe(false);
  });

  it('handles empty fingerprints without dividing by zero', () => {
    const result = compareFingerprints(new Map(), new Map());
    expect(result).toEqual({ identical: 0, common: 0, percent: 0, isMatch: false });
  });

  it('exposes the calibrated thresholds', () => {
    expect(MATCH_PERCENT_THRESHOLD).toBe(20);
    expect(MIN_COMMON_ACHIEVEMENTS).toBe(200);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/compareFingerprints.test.ts`
Expected: FAIL — cannot resolve the module

- [ ] **Step 3: Implement the pure comparison**

Create `src/functions/applications/alts/compareFingerprints.ts`:

```typescript
/** achievement id -> completed timestamp (ms). */
export type Fingerprint = Map<number, number>;

export interface FingerprintMatch {
  identical: number;
  common: number;
  percent: number;
  isMatch: boolean;
}

/**
 * Calibrated against four live accounts: unrelated characters shared a median
 * of 6 identical timestamps out of ~4,000 in common (noise ceiling 3.0%), while
 * genuine same-account pairs ran 31–86%. 20% sits an order of magnitude above
 * the noise and comfortably below the weakest true match observed.
 */
export const MATCH_PERCENT_THRESHOLD = 20;

/** Below this, the sample is too small to judge — a fresh alt with a handful of
 *  account-wide achievements would otherwise score 100%. */
export const MIN_COMMON_ACHIEVEMENTS = 200;

/**
 * Account-wide achievements share an identical completion timestamp across
 * every character on the account, so the proportion of shared achievement ids
 * whose timestamps match identifies same-account characters.
 */
export function compareFingerprints(a: Fingerprint, b: Fingerprint): FingerprintMatch {
  let identical = 0;
  let common = 0;
  for (const [id, timestamp] of a) {
    const other = b.get(id);
    if (other === undefined) continue;
    common++;
    if (other === timestamp) identical++;
  }
  const percent = common === 0 ? 0 : (identical / common) * 100;
  return {
    identical,
    common,
    percent,
    isMatch: common >= MIN_COMMON_ACHIEVEMENTS && percent >= MATCH_PERCENT_THRESHOLD,
  };
}
```

- [ ] **Step 4: Add the Blizzard fetcher**

Append to `src/services/blizzard.ts`:

```typescript
import type { RaiderIoCharacter } from '../functions/applications/raiderIoName.js';
import type { Fingerprint } from '../functions/applications/alts/compareFingerprints.js';

interface AchievementsProfile {
  achievements?: { id: number; completed_timestamp?: number }[];
}

/** Cache wire format. A Map JSON.stringifies to `{}`, so entries are stored. */
type FingerprintEntries = [number, number][];

/**
 * Achievement timestamps are immutable once earned, so the only staleness is a
 * character earning more. A week keeps a sweep cheap without letting a fresh
 * alt stay invisible for long.
 */
export const FINGERPRINT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Throws on any failure so nothing is cached; the caller decides what is fatal. */
async function fetchFingerprintEntries(c: RaiderIoCharacter): Promise<FingerprintEntries> {
  const token = await getAccessToken();
  const realmSlug = encodeURIComponent(normalizeRealmSlug(c.realm));
  const url =
    `https://${c.region}.api.blizzard.com/profile/wow/character/` +
    `${realmSlug}/${encodeURIComponent(c.name.toLowerCase())}/achievements` +
    `?namespace=profile-${c.region}&locale=en_GB`;

  const data = await httpRequest<AchievementsProfile>('blizzard', url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const entries: FingerprintEntries = [];
  for (const a of data.achievements ?? []) {
    if (a.completed_timestamp) entries.push([a.id, a.completed_timestamp]);
  }
  return entries;
}

/**
 * The character's completed achievements as id -> timestamp, cached per
 * character for FINGERPRINT_TTL_MS. Returns null when the character cannot be
 * read (404, private, below the achievement floor) — null means "unknown", and
 * callers must not treat it as "no match".
 *
 * A 429 or open circuit is RETHROWN, not swallowed: the job runner pauses and
 * resumes on those, and turning a rate limit into null would report an
 * account as having no alts. Neither case is cached, so a retry re-fetches.
 *
 * An empty-but-successful fetch IS cached — "this character has earned no
 * achievements" is a real answer, and the TTL bounds how long it lasts.
 */
export async function getCharacterFingerprint(c: RaiderIoCharacter): Promise<Fingerprint | null> {
  const key = `fingerprint:${c.region}:${normalizeRealmSlug(c.realm)}:${c.name.toLowerCase()}`;

  let entries: FingerprintEntries;
  try {
    entries = await getCachedOrFetch<FingerprintEntries>(key, ttl(FINGERPRINT_TTL_MS), () =>
      fetchFingerprintEntries(c),
    );
  } catch (error) {
    if (error instanceof CircuitOpenError) throw error;
    if (error instanceof HttpError && error.status === 429) throw error;
    return null;
  }

  return entries.length > 0 ? new Map(entries) : null;
}
```

Add to the imports at the top of `blizzard.ts`:

```typescript
import { getCachedOrFetch, ttl } from './apiCache.js';
import { CircuitOpenError, HttpError } from './httpClient.js';
```

- [ ] **Step 5: Add cache pruning**

Fingerprints are large: ~4,000 achievements per character serialises to roughly 85 KB, so a single maxed 3,000-character sweep can add ~250 MB to the volume. Nothing currently deletes from `api_cache` except `flushCache`, which drops everything including the achievements-image entries.

Append to `src/services/apiCache.ts`:

```typescript
/**
 * Delete cache entries under `prefix` older than `olderThanMs`, returning the
 * number removed. Prefix-scoped so pruning bulky fingerprints cannot evict the
 * achievements-image entries, which are FOREVER by design.
 */
export function pruneCache(prefix: string, olderThanMs: number): number {
  const db = getDatabase();
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const result = db
    .prepare("DELETE FROM api_cache WHERE key LIKE ? || '%' AND fetched_at < ?")
    .run(prefix, cutoff);
  return result.changes;
}
```

No migration is needed — `api_cache` already exists from schema v9.

- [ ] **Step 6: Test the caching and failure contracts**

Create `tests/unit/blizzardFingerprint.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../src/services/httpClient.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/httpClient.js')>();
  return { ...actual, httpRequest: vi.fn() };
});
vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { httpRequest, HttpError, CircuitOpenError } from '../../src/services/httpClient.js';
import { closeDatabase, getDatabase } from '../../src/database/db.js';
import { createTables } from '../../src/database/schema.js';
import { getCharacterFingerprint } from '../../src/services/blizzard.js';
import { pruneCache } from '../../src/services/apiCache.js';

const mocked = vi.mocked(httpRequest);
const character = { region: 'eu', realm: 'argent-dawn', name: 'Driptinus' };
const achievements = {
  achievements: [
    { id: 1, completed_timestamp: 1_700_000_000_000 },
    { id: 2, completed_timestamp: 1_700_000_000_001 },
    { id: 3 }, // incomplete — excluded
  ],
};

describe('getCharacterFingerprint', () => {
  beforeEach(() => {
    mocked.mockReset();
    createTables(getDatabase(':memory:'));
  });
  afterEach(() => closeDatabase());

  it('maps completed achievements to timestamps', async () => {
    mocked.mockResolvedValueOnce(achievements as never);
    const fp = await getCharacterFingerprint(character);
    expect([...fp!.entries()]).toEqual([
      [1, 1_700_000_000_000],
      [2, 1_700_000_000_001],
    ]);
  });

  it('serves the same character from the cache, surviving the Map round-trip', async () => {
    mocked.mockResolvedValueOnce(achievements as never);
    await getCharacterFingerprint(character);
    const cached = await getCharacterFingerprint(character);
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(cached).toBeInstanceOf(Map);
    expect(cached!.get(1)).toBe(1_700_000_000_000);
  });

  it('returns null for an unreadable character without caching it', async () => {
    mocked.mockRejectedValueOnce(
      new HttpError({ service: 'blizzard', status: 404, attempts: 1, message: 'gone' }),
    );
    expect(await getCharacterFingerprint(character)).toBeNull();

    mocked.mockResolvedValueOnce(achievements as never);
    expect(await getCharacterFingerprint(character)).not.toBeNull();
  });

  it('rethrows a 429 so the job pauses instead of reporting no alts', async () => {
    mocked.mockRejectedValueOnce(
      new HttpError({ service: 'blizzard', status: 429, attempts: 3, message: 'slow down' }),
    );
    await expect(getCharacterFingerprint(character)).rejects.toBeInstanceOf(HttpError);
  });

  it('rethrows an open circuit', async () => {
    mocked.mockRejectedValueOnce(new CircuitOpenError('blizzard'));
    await expect(getCharacterFingerprint(character)).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it('returns null when the character has no completed achievements', async () => {
    mocked.mockResolvedValueOnce({ achievements: [] } as never);
    expect(await getCharacterFingerprint(character)).toBeNull();
  });
});

describe('pruneCache', () => {
  beforeEach(() => createTables(getDatabase(':memory:')));
  afterEach(() => closeDatabase());

  it('removes only stale entries under the given prefix', () => {
    const db = getDatabase();
    const old = new Date(Date.now() - 60_000).toISOString();
    const insert = db.prepare('INSERT INTO api_cache (key, payload, fetched_at) VALUES (?, ?, ?)');
    insert.run('fingerprint:eu:draenor:old', '[]', old);
    insert.run('fingerprint:eu:draenor:fresh', '[]', new Date().toISOString());
    insert.run('static-data:10', '{}', old);

    expect(pruneCache('fingerprint:', 30_000)).toBe(1);
    const keys = (db.prepare('SELECT key FROM api_cache').all() as { key: string }[]).map(
      (r) => r.key,
    );
    expect(keys).toEqual(
      expect.arrayContaining(['fingerprint:eu:draenor:fresh', 'static-data:10']),
    );
    expect(keys).toHaveLength(2);
  });
});
```

`CircuitOpenError`'s constructor signature comes from Task 3 — match whatever it takes there.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/compareFingerprints.test.ts tests/unit/blizzardFingerprint.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
npx prettier --write src/functions/applications/alts/compareFingerprints.ts src/services/blizzard.ts src/services/apiCache.ts tests/unit/compareFingerprints.test.ts tests/unit/blizzardFingerprint.test.ts
git add src/functions/applications/alts/compareFingerprints.ts src/services/blizzard.ts src/services/apiCache.ts tests/unit/compareFingerprints.test.ts tests/unit/blizzardFingerprint.test.ts
git commit -m "feat(alts): add cached Blizzard achievement fingerprint and comparison"
```

---

### Task 11: Log selection — sweep targets, boss matching, merge (pure)

**Files:**

- Create: `src/functions/applications/mythic-logs/selectMythicReports.ts`
- Test: `tests/unit/selectMythicReports.test.ts`

**Interfaces:**

- Consumes: `WclZone`, `WclEncounter` (Task 6)
- Produces:
  - `export interface SweepCandidate { name: string; realm: string; mythicKills: number; tiers: number[] }`
  - `selectSweepTargets(applicantKeys: string[], candidates: SweepCandidate[], slots: number): string[]` — keys are `name-realm` lowercased
  - `matchBossName(zone: WclZone, raiderIoName: string): WclEncounter | null`
  - `export interface BossEvidence { encounterId: number; bossIndex: number; bossName: string; who: string; kind: 'kill' | 'wipe'; date?: string; percent?: number; reportCode: string; isApplicantCharacter: boolean }`
  - `mergeBossEvidence(candidates: BossEvidence[]): BossEvidence[]` — one entry per encounter
  - `selectTierLines(zone: WclZone, evidence: BossEvidence[], maxLines?: number): BossEvidence[]`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/selectMythicReports.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  selectSweepTargets,
  matchBossName,
  mergeBossEvidence,
  selectTierLines,
  type BossEvidence,
} from '../../src/functions/applications/mythic-logs/selectMythicReports.js';
import type { WclZone } from '../../src/functions/applications/mythic-logs/zoneCatalogue.js';

const zone: WclZone = {
  id: 44,
  name: 'Manaforge Omega',
  expansion: 'The War Within',
  encounters: [
    { id: 3129, name: 'Plexus Sentinel' },
    { id: 3131, name: "Loom'ithar" },
    { id: 3133, name: 'Fractillus' },
    { id: 3135, name: 'Dimensius, the All-Devouring' },
  ],
};

describe('selectSweepTargets', () => {
  it('always includes every application-named character, exempt from the slots', () => {
    const chosen = selectSweepTargets(
      ['brentpriest-draenor', 'brenthunter-draenor'],
      [{ name: 'Brentwartwo', realm: 'Draenor', mythicKills: 0, tiers: [46] }],
      1,
    );
    expect(chosen).toContain('brentpriest-draenor');
    expect(chosen).toContain('brenthunter-draenor');
  });

  it('prioritises characters with Mythic kills, most kills first', () => {
    const chosen = selectSweepTargets(
      ['brentpriest-draenor'],
      [
        { name: 'Brentprietwo', realm: 'Draenor', mythicKills: 6, tiers: [46] },
        { name: 'Brenthunter', realm: 'Draenor', mythicKills: 7, tiers: [46] },
        { name: 'Brentwartwo', realm: 'Draenor', mythicKills: 0, tiers: [46] },
      ],
      2,
    );
    expect(chosen.slice(1)).toEqual(['brenthunter-draenor', 'brentprietwo-draenor']);
  });

  it('fills remaining slots by new tier coverage, not recency', () => {
    const chosen = selectSweepTargets(
      ['brentpriest-draenor'],
      [
        { name: 'Brenthunter', realm: 'Draenor', mythicKills: 7, tiers: [46] },
        { name: 'Brentwartwo', realm: 'Draenor', mythicKills: 0, tiers: [46] },
        { name: 'Brentdh', realm: 'Draenor', mythicKills: 0, tiers: [44, 42] },
      ],
      2,
    );
    expect(chosen).toContain('brentdh-draenor');
    expect(chosen).not.toContain('brentwartwo-draenor');
  });

  it('does not exceed the slot count for non-named characters', () => {
    const chosen = selectSweepTargets(
      ['main-realm'],
      [
        { name: 'A', realm: 'Realm', mythicKills: 5, tiers: [1] },
        { name: 'B', realm: 'Realm', mythicKills: 4, tiers: [2] },
        { name: 'C', realm: 'Realm', mythicKills: 3, tiers: [3] },
      ],
      2,
    );
    expect(chosen).toHaveLength(3);
  });
});

describe('matchBossName', () => {
  it('matches an exact name', () => {
    expect(matchBossName(zone, 'Fractillus')?.id).toBe(3133);
  });

  it("matches Raider.IO's truncated slug for a longer WCL name", () => {
    expect(matchBossName(zone, 'dimensius')?.id).toBe(3135);
  });

  it('ignores punctuation and case differences', () => {
    expect(matchBossName(zone, 'loomithar')?.id).toBe(3131);
  });

  it('returns null rather than guessing when nothing matches', () => {
    expect(matchBossName(zone, 'some-future-boss')).toBeNull();
  });

  it('returns null when a prefix is ambiguous', () => {
    const ambiguous: WclZone = {
      ...zone,
      encounters: [
        { id: 1, name: 'The Twin Fangs' },
        { id: 2, name: 'The Twin Fangs Reborn' },
      ],
    };
    expect(matchBossName(ambiguous, 'the-twin-fangs')).not.toBeNull();
    expect(matchBossName(ambiguous, 'the-twin')).toBeNull();
  });
});

const evidence = (over: Partial<BossEvidence>): BossEvidence => ({
  encounterId: 3135,
  bossIndex: 3,
  bossName: 'Dimensius, the All-Devouring',
  who: 'Brenthunter',
  kind: 'kill',
  date: '2025-10-30',
  reportCode: 'AAA',
  isApplicantCharacter: false,
  ...over,
});

describe('mergeBossEvidence', () => {
  it('keeps the earliest kill, not a later re-kill on an alt', () => {
    const merged = mergeBossEvidence([
      evidence({ who: 'Brenthunter', date: '2026-01-01', reportCode: 'LATE' }),
      evidence({ who: 'Brentprietwo', date: '2025-10-30', reportCode: 'FIRST' }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].who).toBe('Brentprietwo');
    expect(merged[0].reportCode).toBe('FIRST');
  });

  it('prefers a kill over any wipe', () => {
    const merged = mergeBossEvidence([
      evidence({ kind: 'wipe', percent: 0.7, date: undefined, reportCode: 'WIPE' }),
      evidence({ kind: 'kill', date: '2025-10-30', reportCode: 'KILL' }),
    ]);
    expect(merged[0].kind).toBe('kill');
  });

  it('prefers the lowest boss percentage between two wipes', () => {
    const merged = mergeBossEvidence([
      evidence({ kind: 'wipe', percent: 40.1, date: undefined, reportCode: 'HIGH' }),
      evidence({ kind: 'wipe', percent: 9.2, date: undefined, reportCode: 'LOW' }),
    ]);
    expect(merged[0].reportCode).toBe('LOW');
  });

  it("keeps the applicant's own character when the evidence ties", () => {
    const merged = mergeBossEvidence([
      evidence({ who: 'Brentdh', date: '2024-11-19', reportCode: 'ALT' }),
      evidence({
        who: 'Brentpriest',
        date: '2024-11-19',
        reportCode: 'OWN',
        isApplicantCharacter: true,
      }),
    ]);
    expect(merged[0].who).toBe('Brentpriest');
  });

  it('keeps one entry per encounter', () => {
    const merged = mergeBossEvidence([
      evidence({ encounterId: 3133, bossIndex: 2 }),
      evidence({ encounterId: 3135, bossIndex: 3 }),
    ]);
    expect(merged).toHaveLength(2);
  });
});

describe('selectTierLines', () => {
  it('takes the deepest bosses first and caps at three lines', () => {
    const lines = selectTierLines(zone, [
      evidence({ encounterId: 3129, bossIndex: 0, reportCode: 'A' }),
      evidence({ encounterId: 3131, bossIndex: 1, reportCode: 'B' }),
      evidence({ encounterId: 3133, bossIndex: 2, reportCode: 'C' }),
      evidence({ encounterId: 3135, bossIndex: 3, reportCode: 'D' }),
    ]);
    expect(lines.map((l) => l.bossIndex)).toEqual([3, 2, 1]);
  });

  it('collapses a report that already covers a deeper boss', () => {
    const lines = selectTierLines(zone, [
      evidence({ encounterId: 3135, bossIndex: 3, reportCode: 'SAME' }),
      evidence({ encounterId: 3133, bossIndex: 2, reportCode: 'SAME' }),
      evidence({ encounterId: 3131, bossIndex: 1, reportCode: 'OTHER' }),
    ]);
    expect(lines.map((l) => l.reportCode)).toEqual(['SAME', 'OTHER']);
  });

  it('returns an empty array when there is no evidence', () => {
    expect(selectTierLines(zone, [])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/selectMythicReports.test.ts`
Expected: FAIL — cannot resolve the module

- [ ] **Step 3: Implement**

Create `src/functions/applications/mythic-logs/selectMythicReports.ts`:

```typescript
import type { WclEncounter, WclZone } from './zoneCatalogue.js';

export const MAX_LINES_PER_TIER = 3;

export interface SweepCandidate {
  name: string;
  realm: string;
  /** Current-expansion Mythic kills from Raider.IO — a prioritiser, not a gate. */
  mythicKills: number;
  /** WCL zone ids this character has raid reports in. */
  tiers: number[];
}

export const characterKey = (name: string, realm: string): string =>
  `${name}-${realm}`.toLowerCase();

/**
 * Which characters get a full WCL sweep: every character named in the
 * application (always, exempt from the slots), then Mythic-kill characters
 * ranked by kill count, then greedy tier coverage for the remaining slots.
 *
 * Coverage rather than recency: on a live account the four most recent alts had
 * all raided the same tier as the main, so recency spent two sweeps to learn
 * nothing, while coverage surfaced an extra expansion's progression.
 */
export function selectSweepTargets(
  applicantKeys: string[],
  candidates: SweepCandidate[],
  slots: number,
): string[] {
  const chosen = [...applicantKeys];
  const taken = new Set(chosen);
  const covered = new Set<number>();

  const withKills = candidates
    .filter((c) => c.mythicKills > 0 && !taken.has(characterKey(c.name, c.realm)))
    .sort((a, b) => b.mythicKills - a.mythicKills);

  for (const c of withKills) {
    if (chosen.length - applicantKeys.length >= slots) break;
    const key = characterKey(c.name, c.realm);
    chosen.push(key);
    taken.add(key);
    for (const t of c.tiers) covered.add(t);
  }

  while (chosen.length - applicantKeys.length < slots) {
    let best: SweepCandidate | null = null;
    let bestNew = 0;
    for (const c of candidates) {
      if (taken.has(characterKey(c.name, c.realm))) continue;
      const fresh = c.tiers.filter((t) => !covered.has(t)).length;
      if (fresh > bestNew) {
        best = c;
        bestNew = fresh;
      }
    }
    if (!best) break;
    const key = characterKey(best.name, best.realm);
    chosen.push(key);
    taken.add(key);
    for (const t of best.tiers) covered.add(t);
  }

  return chosen;
}

const normalise = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Map a Raider.IO boss name onto a WCL encounter. The two sources genuinely
 * disagree — Raider.IO says "Dimensius", WCL says "Dimensius, the
 * All-Devouring" — and share no identifier, so this is prefix matching with a
 * uniqueness requirement. An ambiguous or unknown name returns null, and the
 * caller renders the line without a date rather than dropping the boss.
 */
export function matchBossName(zone: WclZone, raiderIoName: string): WclEncounter | null {
  const needle = normalise(raiderIoName);
  if (!needle) return null;

  const exact = zone.encounters.find((e) => normalise(e.name) === needle);
  if (exact) return exact;

  const prefixed = zone.encounters.filter((e) => {
    const name = normalise(e.name);
    return name.startsWith(needle) || needle.startsWith(name);
  });
  return prefixed.length === 1 ? prefixed[0] : null;
}

export interface BossEvidence {
  encounterId: number;
  bossIndex: number;
  bossName: string;
  who: string;
  kind: 'kill' | 'wipe';
  /** ISO date of the first kill; absent for wipes. */
  date?: string;
  /** Best boss percentage reached; only meaningful for wipes. */
  percent?: number;
  reportCode: string;
  isApplicantCharacter: boolean;
}

/** Lower is better. */
function rank(e: BossEvidence): [number, number, number, number] {
  return [
    e.kind === 'kill' ? 0 : 1,
    e.kind === 'kill' ? new Date(e.date ?? 0).getTime() : (e.percent ?? 100),
    e.isApplicantCharacter ? 0 : 1,
    e.kind === 'kill' ? 0 : -new Date(e.date ?? 0).getTime(),
  ];
}

/**
 * One entry per boss, resolved in order: a kill beats any wipe; the EARLIEST
 * kill across the account wins (a re-kill on an alt months later is not
 * progression); between two wipes the lower boss percentage wins; ties go to
 * the applicant's own character, so their line is never displaced by an alt
 * with identical evidence.
 */
export function mergeBossEvidence(candidates: BossEvidence[]): BossEvidence[] {
  const best = new Map<number, BossEvidence>();
  for (const candidate of candidates) {
    const current = best.get(candidate.encounterId);
    if (!current) {
      best.set(candidate.encounterId, candidate);
      continue;
    }
    const a = rank(candidate);
    const b = rank(current);
    for (let i = 0; i < a.length; i++) {
      if (a[i] === b[i]) continue;
      if (a[i] < b[i]) best.set(candidate.encounterId, candidate);
      break;
    }
  }
  return [...best.values()];
}

/**
 * Up to `maxLines` lines for one tier, deepest boss first, skipping any report
 * already linked for a deeper boss — one log covering bosses 6–8 is one line,
 * not three.
 */
export function selectTierLines(
  zone: WclZone,
  evidence: BossEvidence[],
  maxLines = MAX_LINES_PER_TIER,
): BossEvidence[] {
  const ranked = [...evidence].sort((a, b) => b.bossIndex - a.bossIndex);
  const seenReports = new Set<string>();
  const lines: BossEvidence[] = [];
  for (const entry of ranked) {
    if (seenReports.has(entry.reportCode)) continue;
    seenReports.add(entry.reportCode);
    lines.push(entry);
    if (lines.length >= maxLines) break;
  }
  return lines;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/selectMythicReports.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/functions/applications/mythic-logs/selectMythicReports.ts tests/unit/selectMythicReports.test.ts
git add src/functions/applications/mythic-logs/selectMythicReports.ts tests/unit/selectMythicReports.test.ts
git commit -m "feat(logs): add sweep selection, boss matching and evidence merge"
```

---

### Task 12: Renderers for both messages (pure)

**Files:**

- Create: `src/functions/applications/intel/render.ts`
- Test: `tests/unit/intelRender.test.ts`

**Interfaces:**

- Consumes: `IntelFinding` (Task 5), `BossEvidence` (Task 11), `WclZone` (Task 6)
- Produces:
  - `export interface PauseFooter { service: string; scanned: number; total: number; retryAt?: Date; abandoned?: boolean }`
  - `renderFooter(f: PauseFooter): string`
  - `raiderIoProfileUrl(region: string, realm: string, name: string): string`
  - `renderFoundCharacters(findings: IntelFinding[], applicantName: string, region: string, footer?: PauseFooter): string[]` — pages of embed-description text
  - `export interface RenderedTier { zone: WclZone; lines: BossEvidence[] }`
  - `renderMythicLogs(applicantName: string, tiers: RenderedTier[], sweptCount: number, footer?: PauseFooter): string`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/intelRender.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  renderFooter,
  renderFoundCharacters,
  renderMythicLogs,
  raiderIoProfileUrl,
} from '../../src/functions/applications/intel/render.js';
import type { IntelFinding } from '../../src/functions/applications/intel/jobStore.js';
import type { WclZone } from '../../src/functions/applications/mythic-logs/zoneCatalogue.js';
import type { BossEvidence } from '../../src/functions/applications/mythic-logs/selectMythicReports.js';

const finding = (over: Partial<IntelFinding>): IntelFinding => ({
  name: 'Monkni',
  realm: 'Draenor',
  className: 'Monk',
  guildName: 'Rancour',
  guildRealm: 'Draenor',
  source: 'fingerprint',
  confidence: 93,
  ...over,
});

describe('raiderIoProfileUrl', () => {
  it('lowercases and hyphenates the realm but preserves the name', () => {
    expect(raiderIoProfileUrl('eu', 'Tarren Mill', 'Boptinus')).toBe(
      'https://raider.io/characters/eu/tarren-mill/Boptinus',
    );
  });
});

describe('renderFoundCharacters', () => {
  it('sorts the application character first, then by descending confidence', () => {
    const pages = renderFoundCharacters(
      [
        finding({ name: 'Regnie', confidence: 73 }),
        finding({ name: 'Monkni', confidence: 93 }),
        finding({ name: 'Regnipaw', source: 'application', confidence: null }),
      ],
      'Regnipaw',
      'eu',
    );
    const lines = pages[0].split('\n').filter((l) => l.startsWith('['));
    expect(lines[0]).toContain('Regnipaw');
    expect(lines[0]).toContain('from the application');
    expect(lines[1]).toContain('Monkni');
    expect(lines[2]).toContain('Regnie');
  });

  it('labels non-application characters undeclared with a confidence', () => {
    const pages = renderFoundCharacters([finding({})], 'Regnipaw', 'eu');
    expect(pages[0]).toContain('undeclared (93% confidence)');
  });

  it('links the name to Raider.IO and shows class and guild inline', () => {
    const pages = renderFoundCharacters([finding({})], 'Regnipaw', 'eu');
    expect(pages[0]).toContain('[Monkni-Draenor](https://raider.io/characters/eu/draenor/Monkni)');
    expect(pages[0]).toContain('Monk');
    expect(pages[0]).toContain('Rancour (Draenor)');
  });

  it('says so explicitly when nothing was found', () => {
    expect(renderFoundCharacters([], 'Regnipaw', 'eu')[0]).toContain('No other characters found');
  });

  it('pages when the list exceeds the embed description limit', () => {
    const many = Array.from({ length: 80 }, (_, i) => finding({ name: `Alt${i}`, confidence: 50 }));
    const pages = renderFoundCharacters(many, 'Regnipaw', 'eu');
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) expect(page.length).toBeLessThanOrEqual(4096);
  });

  it('appends the footer to the first page', () => {
    const pages = renderFoundCharacters([finding({})], 'Regnipaw', 'eu', {
      service: 'blizzard',
      scanned: 1240,
      total: 3000,
      retryAt: new Date(1785325500000),
    });
    expect(pages[0]).toContain('Rate limited on blizzard');
  });
});

describe('renderMythicLogs', () => {
  const zone: WclZone = {
    id: 46,
    name: 'VS / DR / MQD',
    expansion: 'Midnight',
    encounters: Array.from({ length: 9 }, (_, i) => ({ id: 3170 + i, name: `Boss ${i + 1}` })),
  };

  const kill: BossEvidence = {
    encounterId: 3177,
    bossIndex: 7,
    bossName: "Belo'ren, Child of Al'ar",
    who: 'Brenthunter',
    kind: 'kill',
    date: '2026-05-03',
    reportCode: 'bgDj26pmAHBdhPk3',
    isApplicantCharacter: false,
  };

  const wipe: BossEvidence = {
    encounterId: 3178,
    bossIndex: 8,
    bossName: 'Midnight Falls',
    who: 'Brentprietwo',
    kind: 'wipe',
    percent: 80.52,
    reportCode: '1rkzLm8jK9x3YCwc',
    isApplicantCharacter: false,
  };

  it('renders kills with a first-kill date and the character', () => {
    const out = renderMythicLogs('Brentpriest', [{ zone, lines: [kill] }], 4);
    expect(out).toContain("8/9 **Belo'ren, Child of Al'ar** — first kill 2026-05-03");
    expect(out).toContain('**Brenthunter**');
    expect(out).toContain('[report](https://www.warcraftlogs.com/reports/bgDj26pmAHBdhPk3)');
  });

  it('renders wipes with the best percentage instead of a date', () => {
    const out = renderMythicLogs('Brentpriest', [{ zone, lines: [wipe] }], 4);
    expect(out).toContain('9/9 **Midnight Falls** — wiping, best 80.5%');
    expect(out).not.toContain('first kill');
  });

  it('heads each tier with its zone and expansion', () => {
    const out = renderMythicLogs('Brentpriest', [{ zone, lines: [kill] }], 4);
    expect(out).toContain('**VS / DR / MQD** *(Midnight)*');
  });

  it('omits the date when the kill date is unknown', () => {
    const out = renderMythicLogs(
      'Brentpriest',
      [{ zone, lines: [{ ...kill, date: undefined }] }],
      4,
    );
    expect(out).toContain('killed');
    expect(out).not.toContain('first kill undefined');
  });

  it('states the empty case explicitly', () => {
    expect(renderMythicLogs('Brentpriest', [], 0)).toContain('No Mythic raid logs found');
  });
});

describe('renderFooter', () => {
  it('names the service, the progress and the retry as a relative timestamp', () => {
    const footer = renderFooter({
      service: 'blizzard',
      scanned: 1240,
      total: 3000,
      retryAt: new Date(1785325500000),
    });
    expect(footer).toContain('Rate limited on blizzard');
    expect(footer).toContain('1,240 of ~3,000');
    expect(footer).toContain('<t:1785325500:R>');
  });

  it('renders a terminal footer with no retry when abandoned', () => {
    const footer = renderFooter({
      service: 'blizzard',
      scanned: 1240,
      total: 3000,
      abandoned: true,
    });
    expect(footer).toContain('Incomplete');
    expect(footer).not.toContain('<t:');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/intelRender.test.ts`
Expected: FAIL — cannot resolve the module

- [ ] **Step 3: Implement**

Create `src/functions/applications/intel/render.ts`:

```typescript
import type { IntelFinding } from './jobStore.js';
import type { BossEvidence } from '../mythic-logs/selectMythicReports.js';
import type { WclZone } from '../mythic-logs/zoneCatalogue.js';

/** Discord embed description limit. */
const EMBED_DESCRIPTION_LIMIT = 4096;
/** Leaves room for the heading and footer we add around the lines. */
const PAGE_BUDGET = 3600;

export interface PauseFooter {
  service: string;
  scanned: number;
  total: number;
  retryAt?: Date;
  abandoned?: boolean;
}

const thousands = (n: number): string => n.toLocaleString('en-GB');

/**
 * The retry time is a Discord relative timestamp so it is correct in every
 * reader's timezone and stays accurate as the wait elapses; a formatted clock
 * time would be neither.
 */
export function renderFooter(f: PauseFooter): string {
  const progress = `${thousands(f.scanned)} of ~${thousands(f.total)} characters scanned`;
  if (f.abandoned) {
    return `*Incomplete — rate limited on ${f.service}, gave up. ${progress}.*`;
  }
  const retry = f.retryAt ? ` Retrying <t:${Math.floor(f.retryAt.getTime() / 1000)}:R>.` : '';
  return `*Rate limited on ${f.service} — ${progress}.${retry}*`;
}

const realmSlug = (realm: string): string => realm.toLowerCase().replace(/\s+/g, '-');

export function raiderIoProfileUrl(region: string, realm: string, name: string): string {
  return `https://raider.io/characters/${region.toLowerCase()}/${realmSlug(realm)}/${name}`;
}

function findingLine(f: IntelFinding, region: string): string {
  const link = `[${f.name}-${f.realm}](${raiderIoProfileUrl(region, f.realm, f.name)})`;
  const guild = f.guildName ? `${f.guildName} (${f.guildRealm ?? '?'})` : 'No guild';
  const provenance =
    f.source === 'application'
      ? 'from the application'
      : `undeclared (${Math.round(f.confidence ?? 100)}% confidence)`;
  return `${link} · ${f.className ?? 'Unknown'} · ${guild} — ${provenance}`;
}

/**
 * The found-characters message. Application characters first, then undeclared
 * by descending confidence — a flat list, because guild grouping would fight
 * that ordering, so guild is shown inline instead. Nothing is filtered out.
 */
export function renderFoundCharacters(
  findings: IntelFinding[],
  applicantName: string,
  region: string,
  footer?: PauseFooter,
): string[] {
  const heading = `**Found characters** — ${findings.length}`;
  if (findings.length === 0) {
    const empty = `**Found characters**\nNo other characters found for **${applicantName}**.`;
    return [footer ? `${empty}\n\n${renderFooter(footer)}` : empty];
  }

  const sorted = [...findings].sort((a, b) => {
    if (a.source === 'application' && b.source !== 'application') return -1;
    if (b.source === 'application' && a.source !== 'application') return 1;
    return (b.confidence ?? 0) - (a.confidence ?? 0);
  });

  const pages: string[] = [];
  let current = `${heading}\n\n`;
  for (const f of sorted) {
    const line = `${findingLine(f, region)}\n`;
    if (current.length + line.length > PAGE_BUDGET) {
      pages.push(current.trimEnd());
      current = '';
    }
    current += line;
  }
  if (current.trim()) pages.push(current.trimEnd());

  if (footer) {
    const withFooter = `${pages[0]}\n\n${renderFooter(footer)}`;
    pages[0] = withFooter.slice(0, EMBED_DESCRIPTION_LIMIT);
  }
  return pages;
}

export interface RenderedTier {
  zone: WclZone;
  lines: BossEvidence[];
}

function logLine(entry: BossEvidence, bossCount: number): string {
  const position = `${entry.bossIndex + 1}/${bossCount}`;
  const status =
    entry.kind === 'kill'
      ? entry.date
        ? `first kill ${entry.date.slice(0, 10)}`
        : 'killed'
      : `wiping, best ${(entry.percent ?? 100).toFixed(1)}%`;
  const link = `[report](https://www.warcraftlogs.com/reports/${entry.reportCode})`;
  return `${position} **${entry.bossName}** — ${status} · **${entry.who}** · ${link}`;
}

/**
 * The logs message. Every line names the character the report belongs to: the
 * message pools the applicant's character with their alts, and without the
 * label a reviewer cannot tell a 4/8 applicant from their 9/9 main.
 */
export function renderMythicLogs(
  applicantName: string,
  tiers: RenderedTier[],
  sweptCount: number,
  footer?: PauseFooter,
): string {
  if (tiers.length === 0) {
    const empty = `**Mythic raid logs — ${applicantName}**\nNo Mythic raid logs found for **${applicantName}** in the last 3 expansions.`;
    return footer ? `${empty}\n\n${renderFooter(footer)}` : empty;
  }

  const suffix = sweptCount > 0 ? ` + ${sweptCount} character${sweptCount === 1 ? '' : 's'}` : '';
  const blocks = tiers.map((tier) => {
    const head = `**${tier.zone.name}** *(${tier.zone.expansion})*`;
    const body = tier.lines.map((l) => logLine(l, tier.zone.encounters.length)).join('\n');
    return `${head}\n${body}`;
  });

  const out = `**Mythic raid logs** — ${applicantName}${suffix}\n\n${blocks.join('\n\n')}`;
  const withFooter = footer ? `${out}\n\n${renderFooter(footer)}` : out;
  return withFooter.slice(0, EMBED_DESCRIPTION_LIMIT);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/intelRender.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/functions/applications/intel/render.ts tests/unit/intelRender.test.ts
git add src/functions/applications/intel/render.ts tests/unit/intelRender.test.ts
git commit -m "feat(intel): render the found-characters and Mythic logs messages"
```

---

### Task 13: Alt discovery — sources and guild BFS

**Files:**

- Create: `src/functions/applications/alts/discoverAlts.ts`
- Test: `tests/unit/discoverAlts.test.ts`

**Interfaces:**

- Consumes: `getCharacterOwner`, `getClaimedCharacters`, `RAIDERIO_INTERNAL_PACE_MS` (Task 9); `getCharacterGuild`, `getCharacterSummary`, `getGuildRoster` (Task 8 + existing); `getCharacterFingerprint` (Task 10); `compareFingerprints` (Task 10); `mapLimit` (Task 2); `jobStore` (Task 5)
- Produces:
  - `export const ALT_CAPS = { guilds: 12, characters: 3000, depth: 3, concurrency: 8 }`
  - `export interface DiscoverDeps { … }` (injected for tests — see code)
  - `discoverAlts(jobId: number, applicants: RaiderIoCharacter[], deps: DiscoverDeps): Promise<{ truncated: boolean }>`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/discoverAlts.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { closeDatabase, getDatabase } from '../../src/database/db.js';
import { createTables } from '../../src/database/schema.js';

vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createJob, getFindings } from '../../src/functions/applications/intel/jobStore.js';
import {
  discoverAlts,
  type DiscoverDeps,
} from '../../src/functions/applications/alts/discoverAlts.js';

const applicant = { region: 'eu', realm: 'draenor', name: 'Brentpriest' };

/** Two same-account characters share timestamps; the third does not. */
const fingerprints: Record<string, Map<number, number>> = {
  brentpriest: new Map(Array.from({ length: 400 }, (_, i) => [i, 1000 + i])),
  brenthunter: new Map(Array.from({ length: 400 }, (_, i) => [i, 1000 + i])),
  stranger: new Map(Array.from({ length: 400 }, (_, i) => [i, 5000 + i])),
};

function deps(over: Partial<DiscoverDeps> = {}): DiscoverDeps {
  return {
    getCharacterOwner: vi.fn(async () => null),
    getClaimedCharacters: vi.fn(async () => []),
    getCharacterSummary: vi.fn(async () => ({ className: 'Priest', guild: null })),
    getCharacterGuild: vi.fn(async () => null),
    getGuildRoster: vi.fn(async () => []),
    getCharacterFingerprint: vi.fn(async (c) => fingerprints[c.name.toLowerCase()] ?? null),
    getMythicKillDates: vi.fn(async () => []),
    tierOrdinals: [35],
    paceMs: 0,
    ...over,
  };
}

describe('discoverAlts', () => {
  let jobId: number;
  beforeEach(() => {
    process.env.DATABASE_PATH = ':memory:';
    createTables(getDatabase());
    jobId = createJob({ applicationId: 1, targetChannelId: '1', character: applicant });
  });
  afterEach(() => closeDatabase());

  it('records the application character itself', async () => {
    await discoverAlts(jobId, [applicant], deps());
    const found = getFindings(jobId);
    expect(found).toHaveLength(1);
    expect(found[0].source).toBe('application');
  });

  it('records claimed characters from the owner lookup at full confidence', async () => {
    await discoverAlts(
      jobId,
      [applicant],
      deps({
        getCharacterOwner: vi.fn(async () => ({
          user: 'Brentoan',
          discordProfile: 'brent',
          declaredMain: null,
        })),
        getClaimedCharacters: vi.fn(async () => [
          { name: 'Brenthunter', realm: 'Draenor', className: 'Hunter', level: 90 },
        ]),
      }),
    );
    const hunter = getFindings(jobId).find((f) => f.name === 'Brenthunter')!;
    expect(hunter.source).toBe('raider.io');
    expect(hunter.confidence).toBe(100);
  });

  it('records a declared main', async () => {
    await discoverAlts(
      jobId,
      [applicant],
      deps({
        getCharacterOwner: vi.fn(async () => ({
          user: null,
          discordProfile: null,
          declaredMain: { region: 'eu', realm: 'draenor', name: 'Brenthunter' },
        })),
      }),
    );
    expect(getFindings(jobId).find((f) => f.name === 'Brenthunter')?.source).toBe('declared main');
  });

  it('fingerprints a guild roster and records only matches', async () => {
    await discoverAlts(
      jobId,
      [applicant],
      deps({
        getCharacterGuild: vi.fn(async () => ({ name: 'Rancour', realm: 'Draenor' })),
        getGuildRoster: vi.fn(async () => [
          { name: 'Brenthunter', realm: 'Draenor' },
          { name: 'Stranger', realm: 'Draenor' },
        ]),
      }),
    );
    const names = getFindings(jobId).map((f) => f.name);
    expect(names).toContain('Brenthunter');
    expect(names).not.toContain('Stranger');
  });

  it('seeds the BFS from former guilds named in the kill history', async () => {
    const getGuildRoster = vi.fn(async () => []);
    await discoverAlts(
      jobId,
      [applicant],
      deps({
        getCharacterGuild: vi.fn(async () => null),
        getGuildRoster,
        getMythicKillDates: vi.fn(async () => [
          {
            bossName: 'imperator-averzian',
            firstDefeated: '2024-12-05T00:00:00.000Z',
            guild: { name: 'SeriouslyCasual', realm: 'silvermoon' },
          },
        ]),
      }),
    );
    expect(getGuildRoster).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'SeriouslyCasual', realm: 'silvermoon' }),
    );
  });

  it("seeds the BFS from a guild's own realm, not the character's", async () => {
    const getGuildRoster = vi.fn(async () => []);
    await discoverAlts(
      jobId,
      [{ region: 'eu', realm: 'argent-dawn', name: 'Driptinus' }],
      deps({
        getCharacterGuild: vi.fn(async () => ({ name: 'Rancour', realm: 'Draenor' })),
        getGuildRoster,
      }),
    );
    expect(getGuildRoster).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Rancour', realm: 'Draenor' }),
    );
  });

  it('never fingerprints the same character twice across overlapping rosters', async () => {
    const getCharacterFingerprint = vi.fn(
      async (c: { name: string }) => fingerprints[c.name.toLowerCase()] ?? null,
    );
    await discoverAlts(
      jobId,
      [applicant],
      deps({
        getCharacterGuild: vi.fn(async () => ({ name: 'Rancour', realm: 'Draenor' })),
        getGuildRoster: vi.fn(async () => [
          { name: 'Stranger', realm: 'Draenor' },
          { name: 'Stranger', realm: 'Draenor' },
        ]),
        getCharacterFingerprint,
      }),
    );
    const strangerCalls = getCharacterFingerprint.mock.calls.filter(([c]) => c.name === 'Stranger');
    expect(strangerCalls).toHaveLength(1);
  });

  it('reports truncation when the character cap is hit', async () => {
    const roster = Array.from({ length: 20 }, (_, i) => ({ name: `Filler${i}`, realm: 'Draenor' }));
    const result = await discoverAlts(
      jobId,
      [applicant],
      deps({
        getCharacterGuild: vi.fn(async () => ({ name: 'Rancour', realm: 'Draenor' })),
        getGuildRoster: vi.fn(async () => roster),
        getCharacterFingerprint: vi.fn(async () => null),
        maxCharacters: 5,
      }),
    );
    expect(result.truncated).toBe(true);
  });

  it('treats an unavailable fingerprint as unknown, not as a non-match', async () => {
    await discoverAlts(
      jobId,
      [applicant],
      deps({
        getCharacterGuild: vi.fn(async () => ({ name: 'Rancour', realm: 'Draenor' })),
        getGuildRoster: vi.fn(async () => [{ name: 'Brenthunter', realm: 'Draenor' }]),
        getCharacterFingerprint: vi.fn(async () => null),
      }),
    );
    expect(getFindings(jobId).map((f) => f.name)).not.toContain('Brenthunter');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/discoverAlts.test.ts`
Expected: FAIL — cannot resolve the module

- [ ] **Step 3: Implement**

Create `src/functions/applications/alts/discoverAlts.ts`:

```typescript
import { logger } from '../../../services/logger.js';
import { mapLimit } from '../../../utils/concurrency.js';
import { compareFingerprints, type Fingerprint } from './compareFingerprints.js';
import { addFinding, isScanned, markScanned, type IntelFinding } from '../intel/jobStore.js';
import type { RaiderIoCharacter } from '../raiderIoName.js';
import type { CharacterGuild, CharacterSummary } from '../../../services/raiderio.js';
import type {
  CharacterOwner,
  ClaimedCharacter,
  MythicKillDate,
} from '../../../services/raiderioInternal.js';

export const ALT_CAPS = {
  guilds: 12,
  characters: 3000,
  depth: 3,
  concurrency: 8,
} as const;

export interface RosterMember {
  name: string;
  realm: string;
}

/** Injected so the BFS can be tested without network access. */
export interface DiscoverDeps {
  getCharacterOwner: (c: RaiderIoCharacter) => Promise<CharacterOwner | null>;
  getClaimedCharacters: (user: string) => Promise<ClaimedCharacter[]>;
  getCharacterSummary: (c: RaiderIoCharacter) => Promise<CharacterSummary | null>;
  getCharacterGuild: (c: RaiderIoCharacter) => Promise<CharacterGuild | null>;
  getGuildRoster: (guild: CharacterGuild) => Promise<RosterMember[]>;
  getCharacterFingerprint: (c: RaiderIoCharacter) => Promise<Fingerprint | null>;
  /** Kill history, used here only for the guilds it names. */
  getMythicKillDates: (
    c: RaiderIoCharacter,
    tierOrdinals: number[],
  ) => Promise<MythicKillDate[] | null>;
  tierOrdinals: number[];
  /** Pace between internal-API calls; 0 in tests. */
  paceMs?: number;
  maxGuilds?: number;
  maxCharacters?: number;
  maxDepth?: number;
}

const key = (name: string, realm: string): string => `${name}-${realm}`.toLowerCase();
const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();

/**
 * Find every character on the applicant's account.
 *
 * Three sources compose rather than compete: the declared main and the owner's
 * claimed-character list are authoritative but often unavailable (four of five
 * live characters tested had the owner privacy-hidden), while the achievement
 * fingerprint always works but only sees shared guilds. Seeding the BFS from
 * EVERY guild the first two sources reveal is what lets the fingerprint reach
 * beyond the applicant's own guild.
 */
export async function discoverAlts(
  jobId: number,
  applicants: RaiderIoCharacter[],
  deps: DiscoverDeps,
): Promise<{ truncated: boolean }> {
  const maxGuilds = deps.maxGuilds ?? ALT_CAPS.guilds;
  const maxCharacters = deps.maxCharacters ?? ALT_CAPS.characters;
  const maxDepth = deps.maxDepth ?? ALT_CAPS.depth;
  const pace = deps.paceMs ?? 0;

  const primary = applicants[0];
  const known = new Map<string, RaiderIoCharacter>();
  const guildFrontier: { guild: CharacterGuild; depth: number }[] = [];
  const visitedGuilds = new Set<string>();
  let truncated = false;

  async function record(
    c: RaiderIoCharacter,
    source: IntelFinding['source'],
    confidence: number | null,
  ): Promise<void> {
    known.set(key(c.name, c.realm), c);
    const summary = await deps.getCharacterSummary(c);
    addFinding(jobId, {
      name: c.name,
      realm: c.realm,
      className: summary?.className ?? null,
      guildName: summary?.guild?.name ?? null,
      guildRealm: summary?.guild?.realm ?? null,
      source,
      confidence,
    });
    if (summary?.guild) {
      const gk = key(summary.guild.name, summary.guild.realm);
      if (!visitedGuilds.has(gk)) guildFrontier.push({ guild: summary.guild, depth: 0 });
    }
  }

  // Source 0: every character the applicant named themselves.
  for (const c of applicants) await record(c, 'application', null);

  // Sources 1 and 2: declared main, then the owner's claimed-character list.
  for (const c of applicants) {
    const owner = await deps.getCharacterOwner(c);
    await sleep(pace);
    if (!owner) continue;

    if (owner.declaredMain && !known.has(key(owner.declaredMain.name, owner.declaredMain.realm))) {
      await record(owner.declaredMain, 'declared main', 100);
    }

    if (owner.user) {
      const claimed = await deps.getClaimedCharacters(owner.user);
      await sleep(pace);
      for (const ch of claimed) {
        if (known.has(key(ch.name, ch.realm))) continue;
        await record({ region: c.region, realm: ch.realm, name: ch.name }, 'raider.io', 100);
      }
    }
  }

  // Seed any guild we have not already queued from the applicants themselves.
  for (const c of applicants) {
    const guild = await deps.getCharacterGuild(c);
    if (!guild) continue;
    const gk = key(guild.name, guild.realm);
    if (
      !visitedGuilds.has(gk) &&
      !guildFrontier.some((g) => key(g.guild.name, g.guild.realm) === gk)
    ) {
      guildFrontier.push({ guild, depth: 0 });
    }
  }

  // FORMER guilds too: every guild named in a known character's kill history.
  // Alts are routinely left behind in a guild the main has since left, and no
  // other readable source reveals those guilds. The data rides along with the
  // kill dates, so it costs nothing extra.
  for (const c of [...known.values()]) {
    const history = await deps.getMythicKillDates(c, deps.tierOrdinals);
    await sleep(pace);
    if (!history) continue;
    for (const past of history) {
      if (!past.guild) continue;
      const pk = key(past.guild.name, past.guild.realm);
      if (visitedGuilds.has(pk)) continue;
      if (guildFrontier.some((g) => key(g.guild.name, g.guild.realm) === pk)) continue;
      guildFrontier.push({ guild: past.guild, depth: 0 });
    }
  }

  // Source 3: fingerprint every roster member of every associated guild.
  const applicantFingerprint = await deps.getCharacterFingerprint(primary);
  if (!applicantFingerprint) {
    logger.warn('Alts', `No fingerprint for ${primary.name}-${primary.realm}; skipping sweep`);
    return { truncated };
  }
  for (const c of known.values()) markScanned(jobId, key(c.name, c.realm));

  let fingerprinted = 0;
  while (guildFrontier.length > 0 && visitedGuilds.size < maxGuilds) {
    const entry = guildFrontier.shift()!;
    const gk = key(entry.guild.name, entry.guild.realm);
    if (visitedGuilds.has(gk)) continue;
    visitedGuilds.add(gk);

    // A guild's realm is its own, frequently not the character's.
    const roster = await deps.getGuildRoster(entry.guild);
    const pending = roster.filter((m) => !isScanned(jobId, key(m.name, m.realm)));

    const budget = maxCharacters - fingerprinted;
    if (pending.length > budget) truncated = true;
    const batch = pending.slice(0, Math.max(0, budget));
    fingerprinted += batch.length;

    const matches = await mapLimit(batch, ALT_CAPS.concurrency, async (member) => {
      markScanned(jobId, key(member.name, member.realm));
      const candidate: RaiderIoCharacter = {
        region: primary.region,
        realm: member.realm,
        name: member.name,
      };
      const fingerprint = await deps.getCharacterFingerprint(candidate).catch(() => null);
      // null is UNKNOWN (private, missing, transient) — never a non-match.
      if (!fingerprint) return null;
      const result = compareFingerprints(applicantFingerprint, fingerprint);
      return result.isMatch ? { candidate, percent: result.percent } : null;
    });

    for (const match of matches) {
      if (!match) continue;
      if (known.has(key(match.candidate.name, match.candidate.realm))) continue;
      await record(match.candidate, 'fingerprint', Math.round(match.percent));
      if (entry.depth + 1 < maxDepth) {
        const guild = await deps.getCharacterGuild(match.candidate);
        if (guild && !visitedGuilds.has(key(guild.name, guild.realm))) {
          guildFrontier.push({ guild, depth: entry.depth + 1 });
        }
      }
    }

    if (fingerprinted >= maxCharacters) {
      truncated = true;
      break;
    }
  }

  if (guildFrontier.length > 0) truncated = true;
  return { truncated };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/discoverAlts.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/functions/applications/alts/discoverAlts.ts tests/unit/discoverAlts.test.ts
git add src/functions/applications/alts/discoverAlts.ts tests/unit/discoverAlts.test.ts
git commit -m "feat(alts): discover account characters across every associated guild"
```

---

### Task 14: Gather Mythic logs across the swept characters

**Files:**

- Create: `src/functions/applications/mythic-logs/gatherMythicLogs.ts`
- Test: `tests/unit/gatherMythicLogs.test.ts`

**Interfaces:**

- Consumes: `WclZone` (Task 6); `getZoneKills`, `getEncounterKills`, `getRaidReports`, `getReportWipes` (Task 7); `getMythicKillDates` (Task 9); `matchBossName`, `mergeBossEvidence`, `selectTierLines`, `BossEvidence` (Task 11)
- Produces:
  - `export interface GatherDeps { … }` (injected)
  - `gatherMythicLogs(applicants: RaiderIoCharacter[], swept: RaiderIoCharacter[], zones: WclZone[], deps: GatherDeps): Promise<RenderedTier[]>` — at most five tiers, newest activity first

- [ ] **Step 1: Write the failing test**

Create `tests/unit/gatherMythicLogs.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import {
  gatherMythicLogs,
  type GatherDeps,
} from '../../src/functions/applications/mythic-logs/gatherMythicLogs.js';
import type { WclZone } from '../../src/functions/applications/mythic-logs/zoneCatalogue.js';

const zone: WclZone = {
  id: 46,
  name: 'VS / DR / MQD',
  expansion: 'Midnight',
  encounters: [
    { id: 3176, name: 'Imperator Averzian' },
    { id: 3181, name: 'Crown of the Cosmos' },
    { id: 3182, name: "Belo'ren, Child of Al'ar" },
    { id: 3183, name: 'Midnight Falls' },
  ],
};

const applicant = { region: 'eu', realm: 'draenor', name: 'Brentpriest' };
const hunter = { region: 'eu', realm: 'draenor', name: 'Brenthunter' };
const prietwo = { region: 'eu', realm: 'draenor', name: 'Brentprietwo' };

function deps(over: Partial<GatherDeps> = {}): GatherDeps {
  return {
    getZoneKills: vi.fn(async () => []),
    getEncounterKills: vi.fn(async () => [{ reportCode: 'REPORT', startTime: 1 }]),
    getRaidReports: vi.fn(async () => []),
    getReportWipes: vi.fn(async () => []),
    getMythicKillDates: vi.fn(async () => []),
    tierOrdinals: [35, 34, 33],
    paceMs: 0,
    ...over,
  };
}

describe('gatherMythicLogs', () => {
  it('attributes each kill to the character WCL says killed it', async () => {
    const tiers = await gatherMythicLogs(
      [applicant],
      [applicant, hunter, prietwo],
      [zone],
      deps({
        getZoneKills: vi.fn(async (c) =>
          c.name === 'Brentprietwo' ? [{ encounterId: 3181, totalKills: 1 }] : [],
        ),
      }),
    );
    const line = tiers[0].lines.find((l) => l.encounterId === 3181)!;
    expect(line.who).toBe('Brentprietwo');
  });

  it('keeps the earliest kill when two characters killed the same boss', async () => {
    const tiers = await gatherMythicLogs(
      [applicant],
      [hunter, prietwo],
      [zone],
      deps({
        getZoneKills: vi.fn(async () => [{ encounterId: 3181, totalKills: 1 }]),
        getMythicKillDates: vi.fn(async (c) =>
          c.name === 'Brentprietwo'
            ? [{ bossName: 'crown-of-the-cosmos', firstDefeated: '2026-04-23T00:00:00.000Z' }]
            : [{ bossName: 'crown-of-the-cosmos', firstDefeated: '2026-06-01T00:00:00.000Z' }],
        ),
      }),
    );
    const line = tiers[0].lines.find((l) => l.encounterId === 3181)!;
    expect(line.who).toBe('Brentprietwo');
    expect(line.date).toBe('2026-04-23T00:00:00.000Z');
  });

  it('still renders a kill when Raider.IO has no date for it', async () => {
    const tiers = await gatherMythicLogs(
      [applicant],
      [hunter],
      [zone],
      deps({
        getZoneKills: vi.fn(async () => [{ encounterId: 3183, totalKills: 1 }]),
        getMythicKillDates: vi.fn(async () => []),
      }),
    );
    const line = tiers[0].lines[0];
    expect(line.kind).toBe('kill');
    expect(line.date).toBeUndefined();
  });

  it('treats unknown kill dates (null) as absent rather than empty', async () => {
    const tiers = await gatherMythicLogs(
      [applicant],
      [hunter],
      [zone],
      deps({
        getZoneKills: vi.fn(async () => [{ encounterId: 3183, totalKills: 1 }]),
        getMythicKillDates: vi.fn(async () => null),
      }),
    );
    expect(tiers[0].lines[0].date).toBeUndefined();
  });

  it('adds a wipe line for the boss after the deepest kill, verified per pull', async () => {
    const tiers = await gatherMythicLogs(
      [applicant],
      [hunter],
      [zone],
      deps({
        getZoneKills: vi.fn(async () => [{ encounterId: 3182, totalKills: 1 }]),
        getRaidReports: vi.fn(async () => [{ code: 'WIPES', startTime: 10, zoneId: 46 }]),
        getReportWipes: vi.fn(async () => [
          { encounterId: 3183, fightId: 1, fightPercentage: 80.5, players: ['Brenthunter'] },
        ]),
      }),
    );
    const wipe = tiers[0].lines.find((l) => l.kind === 'wipe')!;
    expect(wipe.bossName).toBe('Midnight Falls');
    expect(wipe.who).toBe('Brenthunter');
    expect(wipe.percent).toBe(80.5);
  });

  it('ignores a wipe pull none of the account characters were in', async () => {
    const tiers = await gatherMythicLogs(
      [applicant],
      [hunter],
      [zone],
      deps({
        getZoneKills: vi.fn(async () => [{ encounterId: 3182, totalKills: 1 }]),
        getRaidReports: vi.fn(async () => [{ code: 'WIPES', startTime: 10, zoneId: 46 }]),
        getReportWipes: vi.fn(async () => [
          { encounterId: 3183, fightId: 1, fightPercentage: 80.5, players: ['SomeoneElse'] },
        ]),
      }),
    );
    expect(tiers[0].lines.some((l) => l.kind === 'wipe')).toBe(false);
  });

  it('returns no tier at all when nothing was killed or wiped on', async () => {
    expect(await gatherMythicLogs([applicant], [applicant], [zone], deps())).toEqual([]);
  });

  it('caps at five tiers', async () => {
    const zones = Array.from({ length: 8 }, (_, i) => ({ ...zone, id: 40 + i }));
    const tiers = await gatherMythicLogs(
      [applicant],
      [hunter],
      zones,
      deps({ getZoneKills: vi.fn(async () => [{ encounterId: 3176, totalKills: 1 }]) }),
    );
    expect(tiers).toHaveLength(5);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/gatherMythicLogs.test.ts`
Expected: FAIL — cannot resolve the module

- [ ] **Step 3: Implement**

Create `src/functions/applications/mythic-logs/gatherMythicLogs.ts`:

```typescript
import {
  matchBossName,
  mergeBossEvidence,
  selectTierLines,
  type BossEvidence,
} from './selectMythicReports.js';
import type { WclZone } from './zoneCatalogue.js';
import type { RaiderIoCharacter } from '../raiderIoName.js';
import type { RenderedTier } from '../intel/render.js';
import type {
  EncounterKill,
  RaidReportRef,
  WipePull,
  ZoneKill,
} from '../../../services/warcraftlogs.js';
import type { MythicKillDate } from '../../../services/raiderioInternal.js';

export const MAX_TIERS = 5;
/** Reports scanned per tier when looking for a wipe on the next boss. */
const WIPE_SCAN_REPORTS = 8;

export interface GatherDeps {
  getZoneKills: (c: RaiderIoCharacter, zoneId: number) => Promise<ZoneKill[]>;
  getEncounterKills: (c: RaiderIoCharacter, encounterId: number) => Promise<EncounterKill[]>;
  getRaidReports: (c: RaiderIoCharacter, zoneIds: Set<number>) => Promise<RaidReportRef[]>;
  getReportWipes: (code: string) => Promise<WipePull[]>;
  getMythicKillDates: (
    c: RaiderIoCharacter,
    tierOrdinals: number[],
  ) => Promise<MythicKillDate[] | null>;
  tierOrdinals: number[];
  paceMs?: number;
}

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();

/**
 * Pool Mythic progression across the swept characters into at most five tiers.
 *
 * WCL decides what was killed and supplies every link (both keyed on WCL
 * encounter ids); Raider.IO only decorates a kill with its first-kill date, so
 * a naming mismatch costs a date, never a boss.
 */
export async function gatherMythicLogs(
  applicants: RaiderIoCharacter[],
  swept: RaiderIoCharacter[],
  zones: WclZone[],
  deps: GatherDeps,
): Promise<RenderedTier[]> {
  const pace = deps.paceMs ?? 0;
  const applicantNames = new Set(applicants.map((a) => a.name.toLowerCase()));
  const accountNames = new Set(swept.map((c) => c.name.toLowerCase()));
  const zoneById = new Map(zones.map((z) => [z.id, z]));

  // Raider.IO first-kill dates per character, matched onto WCL encounters.
  const datesByCharacter = new Map<string, Map<number, string>>();
  for (const c of swept) {
    const raw = await deps.getMythicKillDates(c, deps.tierOrdinals);
    await sleep(pace);
    // null means UNKNOWN — record nothing rather than "no kills", which would
    // hand first-kill credit to a different character.
    if (!raw) continue;
    const perEncounter = new Map<number, string>();
    for (const entry of raw) {
      for (const zone of zones) {
        const encounter = matchBossName(zone, entry.bossName);
        if (!encounter) continue;
        const existing = perEncounter.get(encounter.id);
        if (!existing || entry.firstDefeated < existing) {
          perEncounter.set(encounter.id, entry.firstDefeated);
        }
        break;
      }
    }
    datesByCharacter.set(c.name.toLowerCase(), perEncounter);
  }

  const evidenceByZone = new Map<number, BossEvidence[]>();

  for (const zone of zones) {
    for (const c of swept) {
      const kills = await deps.getZoneKills(c, zone.id);
      if (kills.length === 0) continue;
      const dates = datesByCharacter.get(c.name.toLowerCase());

      for (const kill of kills) {
        const index = zone.encounters.findIndex((e) => e.id === kill.encounterId);
        if (index < 0) continue;
        const reports = await deps.getEncounterKills(c, kill.encounterId);
        const first = reports[0];
        if (!first) continue;
        const list = evidenceByZone.get(zone.id) ?? [];
        list.push({
          encounterId: kill.encounterId,
          bossIndex: index,
          bossName: zone.encounters[index].name,
          who: c.name,
          kind: 'kill',
          date: dates?.get(kill.encounterId),
          reportCode: first.reportCode,
          isApplicantCharacter: applicantNames.has(c.name.toLowerCase()),
        });
        evidenceByZone.set(zone.id, list);
      }
    }
  }

  // One wipe line per tier: the boss immediately after the deepest kill.
  for (const [zoneId, evidence] of evidenceByZone) {
    const zone = zoneById.get(zoneId)!;
    const deepest = Math.max(...evidence.map((e) => e.bossIndex));
    const target = zone.encounters[deepest + 1];
    if (!target) continue;

    let found: BossEvidence | null = null;
    for (const c of swept) {
      if (found) break;
      const reports = (await deps.getRaidReports(c, new Set([zoneId])))
        .sort((a, b) => b.startTime - a.startTime)
        .slice(0, WIPE_SCAN_REPORTS);
      for (const report of reports) {
        const wipes = (await deps.getReportWipes(report.code))
          .filter((w) => w.encounterId === target.id)
          .filter((w) => w.players.some((p) => accountNames.has(p.toLowerCase())))
          .sort((a, b) => a.fightPercentage - b.fightPercentage);
        const best = wipes[0];
        if (!best) continue;
        const who = best.players.find((p) => accountNames.has(p.toLowerCase()))!;
        found = {
          encounterId: target.id,
          bossIndex: deepest + 1,
          bossName: target.name,
          who,
          kind: 'wipe',
          percent: best.fightPercentage,
          reportCode: report.code,
          isApplicantCharacter: applicantNames.has(who.toLowerCase()),
        };
        break;
      }
    }
    if (found) evidence.push(found);
  }

  const tiers: RenderedTier[] = [];
  for (const [zoneId, evidence] of evidenceByZone) {
    const zone = zoneById.get(zoneId)!;
    const lines = selectTierLines(zone, mergeBossEvidence(evidence));
    if (lines.length > 0) tiers.push({ zone, lines });
  }

  // Newest expansion content first — zone ids increase over time.
  tiers.sort((a, b) => b.zone.id - a.zone.id);
  return tiers.slice(0, MAX_TIERS);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/gatherMythicLogs.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/functions/applications/mythic-logs/gatherMythicLogs.ts tests/unit/gatherMythicLogs.test.ts
git add src/functions/applications/mythic-logs/gatherMythicLogs.ts tests/unit/gatherMythicLogs.test.ts
git commit -m "feat(logs): gather attributed Mythic progression across swept characters"
```

---

### Task 15: The job runner

**Files:**

- Create: `src/functions/applications/intel/runJob.ts`
- Test: `tests/unit/intelRunJob.test.ts`

**Interfaces:**

- Consumes: everything above
- Produces:
  - `export interface RunDeps { editMessage: (channelId: string, messageId: string, description: string) => Promise<void>; discover: typeof discoverAlts; gather: typeof gatherMythicLogs; getZoneCatalogue: () => Promise<WclZone[]>; getMythicKillCount: (c: RaiderIoCharacter) => Promise<number>; getRaidReports: (c, zoneIds) => Promise<RaidReportRef[]>; tierOrdinals: number[]; now?: () => Date }`
  - `runJob(jobId: number, deps: RunDeps): Promise<void>`
  - `MAX_JOB_ATTEMPTS = 20`, `MAX_JOB_AGE_MS = 7 * 24 * 60 * 60 * 1000`, `ALT_SWEEP_SLOTS = 4`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/intelRunJob.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { closeDatabase, getDatabase } from '../../src/database/db.js';
import { createTables } from '../../src/database/schema.js';

vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  createJob,
  getJob,
  setMessageIds,
  addFinding,
} from '../../src/functions/applications/intel/jobStore.js';
import { runJob, type RunDeps } from '../../src/functions/applications/intel/runJob.js';
import { HttpError } from '../../src/services/httpClient.js';

const character = { region: 'eu', realm: 'draenor', name: 'Brentpriest' };
const zone = {
  id: 46,
  name: 'VS / DR / MQD',
  expansion: 'Midnight',
  encounters: [
    { id: 1, name: 'A' },
    { id: 2, name: 'B' },
  ],
};

function deps(over: Partial<RunDeps> = {}): RunDeps {
  return {
    editMessage: vi.fn(async () => {}),
    discover: vi.fn(async () => ({ truncated: false })),
    gather: vi.fn(async () => []),
    getZoneCatalogue: vi.fn(async () => [zone]),
    getMythicKillCount: vi.fn(async () => 0),
    getRaidReports: vi.fn(async () => []),
    tierOrdinals: [35],
    ...over,
  } as RunDeps;
}

describe('runJob', () => {
  let jobId: number;
  beforeEach(() => {
    process.env.DATABASE_PATH = ':memory:';
    createTables(getDatabase());
    jobId = createJob({ applicationId: 1, targetChannelId: 'chan', character });
    setMessageIds(jobId, { alts: 'ALTS', logs: 'LOGS' });
  });
  afterEach(() => closeDatabase());

  it('completes the job and edits both messages', async () => {
    const editMessage = vi.fn(async () => {});
    await runJob(jobId, deps({ editMessage }));
    expect(getJob(jobId)?.status).toBe('done');
    const edited = editMessage.mock.calls.map(([, messageId]) => messageId);
    expect(edited).toContain('ALTS');
    expect(edited).toContain('LOGS');
  });

  it('pauses on a 429 and records the service and retry time', async () => {
    await runJob(
      jobId,
      deps({
        discover: vi.fn(async () => {
          throw new HttpError({
            service: 'blizzard',
            status: 429,
            attempts: 1,
            message: 'rate limited',
            retryAfterMs: 60_000,
          });
        }),
      }),
    );
    const job = getJob(jobId)!;
    expect(job.status).toBe('paused');
    expect(job.paused_service).toBe('blizzard');
    expect(new Date(job.resume_after!).getTime()).toBeGreaterThan(Date.now());
  });

  it('writes the rate-limit footer to both messages when it pauses', async () => {
    const editMessage = vi.fn(async () => {});
    await runJob(
      jobId,
      deps({
        editMessage,
        discover: vi.fn(async () => {
          throw new HttpError({
            service: 'blizzard',
            status: 429,
            attempts: 1,
            message: 'rate limited',
            retryAfterMs: 60_000,
          });
        }),
      }),
    );
    const bodies = editMessage.mock.calls.map(([, , description]) => description);
    expect(bodies).toHaveLength(2);
    for (const body of bodies) expect(body).toContain('Rate limited on blizzard');
  });

  it('does not pause on a non-rate-limit error, and still finishes', async () => {
    await runJob(
      jobId,
      deps({
        gather: vi.fn(async () => {
          throw new Error('boom');
        }),
      }),
    );
    expect(getJob(jobId)?.status).toBe('done');
  });

  it('abandons the job past the attempt cap and says so in the messages', async () => {
    getDatabase().prepare('UPDATE applicant_intel_jobs SET attempts = 20 WHERE id = ?').run(jobId);
    addFinding(jobId, {
      name: 'Brentpriest',
      realm: 'Draenor',
      className: 'Priest',
      guildName: null,
      guildRealm: null,
      source: 'application',
      confidence: null,
    });

    const editMessage = vi.fn(async () => {});
    await runJob(
      jobId,
      deps({
        editMessage,
        discover: vi.fn(async () => {
          throw new HttpError({
            service: 'blizzard',
            status: 429,
            attempts: 1,
            message: 'rate limited',
          });
        }),
      }),
    );

    expect(getJob(jobId)?.status).toBe('failed');
    const bodies = editMessage.mock.calls.map(([, , description]) => description);
    expect(bodies.some((b) => b.includes('Incomplete'))).toBe(true);
  });

  it('marks the job running while it works', async () => {
    let observed: string | undefined;
    await runJob(
      jobId,
      deps({
        discover: vi.fn(async () => {
          observed = getJob(jobId)?.status;
          return { truncated: false };
        }),
      }),
    );
    expect(observed).toBe('running');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/intelRunJob.test.ts`
Expected: FAIL — cannot resolve the module

- [ ] **Step 3: Implement**

Create `src/functions/applications/intel/runJob.ts`:

```typescript
import { logger } from '../../../services/logger.js';
import { classifyError } from './rateLimit.js';
import {
  getFindings,
  getJob,
  pauseJob,
  scannedCount,
  setPhase,
  setStatus,
  type IntelFinding,
} from './jobStore.js';
import { renderFoundCharacters, renderMythicLogs, type PauseFooter } from './render.js';
import { discoverAlts, ALT_CAPS } from '../alts/discoverAlts.js';
import { gatherMythicLogs } from '../mythic-logs/gatherMythicLogs.js';
import {
  selectSweepTargets,
  characterKey,
  type SweepCandidate,
} from '../mythic-logs/selectMythicReports.js';
import type { WclZone } from '../mythic-logs/zoneCatalogue.js';
import type { RaidReportRef } from '../../../services/warcraftlogs.js';
import type { RaiderIoCharacter } from '../raiderIoName.js';

export const MAX_JOB_ATTEMPTS = 20;
export const MAX_JOB_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Alts given a full log sweep, on top of every application-named character. */
export const ALT_SWEEP_SLOTS = 4;

export interface RunDeps {
  editMessage: (channelId: string, messageId: string, description: string) => Promise<void>;
  discover: typeof discoverAlts;
  gather: typeof gatherMythicLogs;
  getZoneCatalogue: () => Promise<WclZone[]>;
  getMythicKillCount: (c: RaiderIoCharacter) => Promise<number>;
  getRaidReports: (c: RaiderIoCharacter, zoneIds: Set<number>) => Promise<RaidReportRef[]>;
  tierOrdinals: number[];
  now?: () => Date;
}

function findingToCharacter(f: IntelFinding, region: string): RaiderIoCharacter {
  return { region, realm: f.realm, name: f.name };
}

/**
 * Run one applicant-intel job to completion, a pause, or abandonment.
 *
 * Only rate limiting pauses; any other failure degrades that phase and the job
 * still publishes what it has, because an application must never be left with a
 * placeholder reading "searching…".
 */
export async function runJob(jobId: number, deps: RunDeps): Promise<void> {
  const job = getJob(jobId);
  if (!job || !job.target_channel_id) return;

  const now = deps.now ?? (() => new Date());
  const applicant: RaiderIoCharacter = {
    region: job.character_region,
    realm: job.character_realm,
    name: job.character_name,
  };

  setStatus(jobId, 'running');

  const publish = async (footer?: PauseFooter): Promise<void> => {
    const findings = getFindings(jobId);
    const channelId = job.target_channel_id!;

    if (job.alts_message_id) {
      const pages = renderFoundCharacters(findings, applicant.name, applicant.region, footer);
      await deps.editMessage(channelId, job.alts_message_id, pages[0]);
    }
    if (job.logs_message_id) {
      await deps.editMessage(
        channelId,
        job.logs_message_id,
        renderMythicLogs(applicant.name, lastTiers, Math.max(0, sweptCount - 1), footer),
      );
    }
  };

  let lastTiers: Awaited<ReturnType<typeof gatherMythicLogs>> = [];
  let sweptCount = 0;

  try {
    // Phase: alt sources + fingerprint sweep.
    setPhase(jobId, 'alt_sources');
    const { truncated } = await deps.discover(jobId, [applicant], {
      getCharacterOwner: (await import('../../../services/raiderioInternal.js')).getCharacterOwner,
      getClaimedCharacters: (await import('../../../services/raiderioInternal.js'))
        .getClaimedCharacters,
      getCharacterSummary: (await import('../../../services/raiderio.js')).getCharacterSummary,
      getCharacterGuild: (await import('../../../services/raiderio.js')).getCharacterGuild,
      // getFullGuildRoster, NOT getGuildRoster: the latter is hardcoded to our
      // own guild and filters to ROSTER_RANKS, which would silently drop members
      // of a stranger's guild. See Task 8.
      getGuildRoster: async (guild) => {
        const { getFullGuildRoster } = await import('../../../services/raiderio.js');
        const roster = await getFullGuildRoster(guild.name, guild.realm);
        return roster.map((m) => ({ name: m.name, realm: m.realm }));
      },
      getCharacterFingerprint: (await import('../../../services/blizzard.js'))
        .getCharacterFingerprint,
      getMythicKillDates: (await import('../../../services/raiderioInternal.js'))
        .getMythicKillDates,
      tierOrdinals: deps.tierOrdinals,
      paceMs: (await import('../../../services/raiderioInternal.js')).RAIDERIO_INTERNAL_PACE_MS,
    });
    if (truncated) {
      logger.warn('Intel', `Job #${jobId}: alt sweep truncated by caps`);
    }

    // Phase: which characters deserve a log sweep, then the sweep itself.
    setPhase(jobId, 'alt_logs');
    const zones = await deps.getZoneCatalogue();
    const zoneIds = new Set(zones.map((z) => z.id));
    const findings = getFindings(jobId);

    const candidates: SweepCandidate[] = [];
    for (const f of findings) {
      if (f.source === 'application') continue;
      const c = findingToCharacter(f, applicant.region);
      const reports = await deps.getRaidReports(c, zoneIds);
      candidates.push({
        name: f.name,
        realm: f.realm,
        mythicKills: await deps.getMythicKillCount(c),
        tiers: [...new Set(reports.map((r) => r.zoneId))],
      });
    }

    const applicantKeys = findings
      .filter((f) => f.source === 'application')
      .map((f) => characterKey(f.name, f.realm));
    const chosen = new Set(selectSweepTargets(applicantKeys, candidates, ALT_SWEEP_SLOTS));
    const swept = findings
      .filter((f) => chosen.has(characterKey(f.name, f.realm)))
      .map((f) => findingToCharacter(f, applicant.region));
    sweptCount = swept.length;

    setPhase(jobId, 'logs');
    lastTiers = await deps.gather([applicant], swept.length > 0 ? swept : [applicant], zones, {
      getZoneKills: (await import('../../../services/warcraftlogs.js')).getZoneKills,
      getEncounterKills: (await import('../../../services/warcraftlogs.js')).getEncounterKills,
      getRaidReports: deps.getRaidReports,
      getReportWipes: (await import('../../../services/warcraftlogs.js')).getReportWipes,
      getMythicKillDates: (await import('../../../services/raiderioInternal.js'))
        .getMythicKillDates,
      tierOrdinals: deps.tierOrdinals,
      paceMs: (await import('../../../services/raiderioInternal.js')).RAIDERIO_INTERNAL_PACE_MS,
    });

    setPhase(jobId, 'done');
    setStatus(jobId, 'done');
    await publish();
  } catch (error) {
    const decision = classifyError(error, job.attempts + 1);
    const age = now().getTime() - new Date(job.created_at).getTime();
    const exhausted = job.attempts + 1 >= MAX_JOB_ATTEMPTS || age >= MAX_JOB_AGE_MS;

    if (!decision.pause) {
      logger.warn('Intel', `Job #${jobId} failed in phase ${job.phase}: ${error}`);
      setStatus(jobId, 'done');
      await publish();
      return;
    }

    const service = decision.service ?? 'unknown';
    if (exhausted) {
      setStatus(jobId, 'failed');
      await publish({
        service,
        scanned: scannedCount(jobId),
        total: ALT_CAPS.characters,
        abandoned: true,
      });
      logger.warn('Intel', `Job #${jobId} abandoned after ${job.attempts + 1} attempts`);
      return;
    }

    pauseJob(jobId, service, decision.resumeAfterMs ?? 0);
    const paused = getJob(jobId);
    await publish({
      service,
      scanned: scannedCount(jobId),
      total: ALT_CAPS.characters,
      retryAt: paused?.resume_after ? new Date(paused.resume_after) : undefined,
    });
    logger.info('Intel', `Job #${jobId} paused on ${service}; resuming ${paused?.resume_after}`);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/intelRunJob.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/functions/applications/intel/runJob.ts tests/unit/intelRunJob.test.ts
git add src/functions/applications/intel/runJob.ts tests/unit/intelRunJob.test.ts
git commit -m "feat(intel): add the job runner with pause, resume and publish"
```

---

### Task 16: Placeholders in the forum post, and the submit hook

**Files:**

- Create: `src/functions/applications/intel/placeholders.ts`
- Modify: `src/functions/applications/createForumPost.ts` (between the Q&A sends at lines 86–88 and the voting embed at line 95)
- Modify: `src/functions/applications/submitApplication.ts` (after `notifyOverlords`, around line 160)
- Test: `tests/unit/intelPlaceholders.test.ts`

**Interfaces:**

- Consumes: `jobStore`, `render`, `collectRaiderIoCharacters`
- Produces:
  - `placeholderEmbed(kind: 'alts' | 'logs'): EmbedBuilder`
  - `startIntelJob(input: { applicationId: number | null; targetChannelId: string; character: RaiderIoCharacter; altsMessageId?: string; logsMessageId?: string }): number`
  - `createForumPost` returns `{ forumPost, threadId, altsMessageId, logsMessageId }`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/intelPlaceholders.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { closeDatabase, getDatabase } from '../../src/database/db.js';
import { createTables } from '../../src/database/schema.js';

vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  placeholderEmbed,
  startIntelJob,
} from '../../src/functions/applications/intel/placeholders.js';
import { getJob } from '../../src/functions/applications/intel/jobStore.js';

const character = { region: 'eu', realm: 'draenor', name: 'Brentpriest' };

describe('placeholderEmbed', () => {
  it('says searching for the alts message', () => {
    expect(placeholderEmbed('alts').toJSON().description).toContain('searching');
  });

  it('says fetching for the logs message', () => {
    expect(placeholderEmbed('logs').toJSON().description).toContain('fetching');
  });
});

describe('startIntelJob', () => {
  beforeEach(() => {
    process.env.DATABASE_PATH = ':memory:';
    createTables(getDatabase());
  });
  afterEach(() => closeDatabase());

  it('creates a pending job carrying both message ids', () => {
    const id = startIntelJob({
      applicationId: 5,
      targetChannelId: 'chan',
      character,
      altsMessageId: 'A',
      logsMessageId: 'L',
    });
    const job = getJob(id)!;
    expect(job.status).toBe('pending');
    expect(job.alts_message_id).toBe('A');
    expect(job.logs_message_id).toBe('L');
    expect(job.application_id).toBe(5);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/intelPlaceholders.test.ts`
Expected: FAIL — cannot resolve the module

- [ ] **Step 3: Implement the helper**

Create `src/functions/applications/intel/placeholders.ts`:

```typescript
import { EmbedBuilder, Colors } from 'discord.js';
import { createJob, setMessageIds } from './jobStore.js';
import type { RaiderIoCharacter } from '../raiderIoName.js';

/**
 * Discord cannot insert a message between existing ones, and the sweep takes
 * seconds to minutes, so the reading order (Q&A -> characters -> logs ->
 * voting) is only achievable by reserving these two positions up front and
 * editing them in place.
 */
export function placeholderEmbed(kind: 'alts' | 'logs'): EmbedBuilder {
  const description =
    kind === 'alts' ? '**Found characters** — searching…' : '**Mythic raid logs** — fetching…';
  return new EmbedBuilder().setColor(Colors.Grey).setDescription(description);
}

export function startIntelJob(input: {
  applicationId: number | null;
  targetChannelId: string;
  character: RaiderIoCharacter;
  altsMessageId?: string;
  logsMessageId?: string;
}): number {
  const jobId = createJob({
    applicationId: input.applicationId,
    targetChannelId: input.targetChannelId,
    character: input.character,
  });
  setMessageIds(jobId, { alts: input.altsMessageId, logs: input.logsMessageId });
  return jobId;
}
```

- [ ] **Step 4: Post the placeholders in `createForumPost`**

In `src/functions/applications/createForumPost.ts`, after the loop that sends `messages[i]` (line 86–88) and **before** the voting embed block (line 94), add:

```typescript
// Reserve the intel positions before the voting controls; the background job
// edits these in place as each phase completes.
let altsMessageId: string | undefined;
let logsMessageId: string | undefined;
try {
  const altsMessage = await thread.send({ embeds: [placeholderEmbed('alts')] });
  altsMessageId = altsMessage.id;
  const logsMessage = await thread.send({ embeds: [placeholderEmbed('logs')] });
  logsMessageId = logsMessage.id;
} catch (err) {
  const error = err instanceof Error ? err : new Error(String(err));
  logger.warn(
    'Applications',
    `Failed to post intel placeholders for application #${applicationId}: ${error.message}`,
  );
}
```

Import it at the top:

```typescript
import { placeholderEmbed } from './intel/placeholders.js';
```

Widen the result interface and the return statement:

```typescript
export interface CreateForumPostResult {
  forumPost: { id: string };
  threadId: string;
  altsMessageId?: string;
  logsMessageId?: string;
}
```

```typescript
return { forumPost: { id: forum.id }, threadId: thread.id, altsMessageId, logsMessageId };
```

- [ ] **Step 5: Start the job from `submitApplication`**

In `src/functions/applications/submitApplication.ts`, capture the new fields where `createForumPost` is called (line 98):

```typescript
const result = await createForumPost(guild, characterName, user, qaText, applicationId);
forumPost = result.forumPost;
threadId = result.threadId;
altsMessageId = result.altsMessageId;
logsMessageId = result.logsMessageId;
```

declaring `let altsMessageId: string | undefined;` and `let logsMessageId: string | undefined;` beside the existing `forumPost` / `threadId` declarations, then after the `notifyOverlords` block add:

```typescript
// Step 5: kick off the applicant intel sweep. The job row is written before
// any API call, so a crash here loses nothing — the scheduler picks it up.
const named = collectRaiderIoCharacters(answers);
if (named.length > 0 && threadId) {
  try {
    const jobId = startIntelJob({
      applicationId,
      targetChannelId: threadId,
      character: named[0],
      altsMessageId,
      logsMessageId,
    });
    logger.info('Applications', `Queued intel job #${jobId} for application #${applicationId}`);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.warn(
      'Applications',
      `Failed to queue intel job for #${applicationId}: ${error.message}`,
    );
  }
}
```

with imports:

```typescript
import { startIntelJob } from './intel/placeholders.js';
import { collectRaiderIoCharacters } from './raiderIoName.js';
```

Note it only _queues_; the scheduler runs it, so submission stays fast and an intel failure can never fail an application.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS — including the existing `createForumPost` tests, which must still pass with the widened return type

- [ ] **Step 7: Commit**

```bash
npx prettier --write src/functions/applications/intel/placeholders.ts src/functions/applications/createForumPost.ts src/functions/applications/submitApplication.ts tests/unit/intelPlaceholders.test.ts
git add src/functions/applications/intel/placeholders.ts src/functions/applications/createForumPost.ts src/functions/applications/submitApplication.ts tests/unit/intelPlaceholders.test.ts
git commit -m "feat(applications): post intel placeholders and queue the sweep on submit"
```

---

### Task 17: Scheduler task and crash recovery

**Files:**

- Create: `src/functions/applications/intel/resumeJobs.ts`
- Modify: `src/events/ready.ts` (register beside the existing crons around line 115; `resetRunningJobs` next to `resumeSessions` at line 125)
- Test: `tests/unit/intelResumeJobs.test.ts`

**Interfaces:**

- Consumes: `dueJobs`, `resetRunningJobs` (Task 5); `runJob` (Task 15); `pruneCache` (Task 10); `FINGERPRINT_TTL_MS` (Task 10)
- Produces: `resumeApplicantIntelJobs(client: Client, run?: (jobId: number) => Promise<void>): Promise<number>`; `recoverInterruptedJobs(): number`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/intelResumeJobs.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { closeDatabase, getDatabase } from '../../src/database/db.js';
import { createTables } from '../../src/database/schema.js';

vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  createJob,
  pauseJob,
  setStatus,
  getJob,
} from '../../src/functions/applications/intel/jobStore.js';
import {
  resumeApplicantIntelJobs,
  recoverInterruptedJobs,
} from '../../src/functions/applications/intel/resumeJobs.js';

const character = { region: 'eu', realm: 'draenor', name: 'Brentpriest' };
const client = {} as never;

describe('resumeApplicantIntelJobs', () => {
  beforeEach(() => {
    process.env.DATABASE_PATH = ':memory:';
    createTables(getDatabase());
  });
  afterEach(() => closeDatabase());

  it('runs pending jobs', async () => {
    const id = createJob({ applicationId: 1, targetChannelId: 'c', character });
    const run = vi.fn(async () => {});
    expect(await resumeApplicantIntelJobs(client, run)).toBe(1);
    expect(run).toHaveBeenCalledWith(id);
  });

  it('skips a paused job whose wait has not elapsed', async () => {
    const id = createJob({ applicationId: 1, targetChannelId: 'c', character });
    pauseJob(id, 'blizzard', 600_000);
    const run = vi.fn(async () => {});
    expect(await resumeApplicantIntelJobs(client, run)).toBe(0);
    expect(run).not.toHaveBeenCalled();
  });

  it('keeps going when one job throws', async () => {
    createJob({ applicationId: 1, targetChannelId: 'c', character });
    createJob({ applicationId: 2, targetChannelId: 'c', character });
    let calls = 0;
    const run = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('boom');
    });
    await resumeApplicantIntelJobs(client, run);
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('recoverInterruptedJobs', () => {
  beforeEach(() => {
    process.env.DATABASE_PATH = ':memory:';
    createTables(getDatabase());
  });
  afterEach(() => closeDatabase());

  it('resets jobs left running by a crash', () => {
    const id = createJob({ applicationId: 1, targetChannelId: 'c', character });
    setStatus(id, 'running');
    expect(recoverInterruptedJobs()).toBe(1);
    expect(getJob(id)?.status).toBe('pending');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/intelResumeJobs.test.ts`
Expected: FAIL — cannot resolve the module

- [ ] **Step 3: Implement**

Create `src/functions/applications/intel/resumeJobs.ts`:

```typescript
import type { Client, TextChannel } from 'discord.js';
import { logger } from '../../../services/logger.js';
import { dueJobs, resetRunningJobs } from './jobStore.js';
import { runJob } from './runJob.js';
import { getZoneCatalogue, getRaidReports } from '../../../services/warcraftlogs.js';
import { getMythicKillCount } from '../../../services/raiderio.js';
import { discoverAlts } from '../alts/discoverAlts.js';
import { gatherMythicLogs } from '../mythic-logs/gatherMythicLogs.js';

/** Raider.IO tier ordinals covering the last three expansions. Numeric and
 *  descending: 35 is the current tier, 28 reaches the oldest in the window. */
const TIER_ORDINALS = [35, 34, 33, 32, 31, 30, 29, 28];

async function editMessage(
  client: Client,
  channelId: string,
  messageId: string,
  description: string,
): Promise<void> {
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased()) return;
  const message = await (channel as TextChannel).messages.fetch(messageId);
  const embed = message.embeds[0];
  await message.edit({
    embeds: [{ ...embed?.toJSON(), description }],
  });
}

/** Scheduler tick: run every job that is pending or whose pause has elapsed. */
export async function resumeApplicantIntelJobs(
  client: Client,
  run?: (jobId: number) => Promise<void>,
): Promise<number> {
  const jobs = dueJobs(new Date().toISOString());
  let ran = 0;
  for (const job of jobs) {
    try {
      if (run) {
        await run(job.id);
      } else {
        await runJob(job.id, {
          editMessage: (channelId, messageId, description) =>
            editMessage(client, channelId, messageId, description),
          discover: discoverAlts,
          gather: gatherMythicLogs,
          getZoneCatalogue,
          getMythicKillCount,
          getRaidReports,
          tierOrdinals: TIER_ORDINALS,
        });
      }
      ran++;
    } catch (error) {
      // One bad job must not stop the rest of the queue.
      logger.error('Intel', `Job #${job.id} threw outside runJob: ${error}`, error as Error);
    }
  }
  return ran;
}

/** A job left 'running' by a crash cannot resume itself — same shape as
 *  resumeSessions for DM questionnaires. */
export function recoverInterruptedJobs(): number {
  const reset = resetRunningJobs();
  if (reset > 0) logger.info('Intel', `Reset ${reset} interrupted intel job(s) to pending`);

  // Fingerprints are ~85 KB each and a maxed sweep caches 3,000 of them, so
  // expired entries are dropped at boot rather than left to grow the volume.
  // Prefix-scoped: the achievements-image cache entries are FOREVER and must
  // survive. Once per start is enough — the TTL is a week.
  const pruned = pruneCache('fingerprint:', FINGERPRINT_TTL_MS);
  if (pruned > 0) logger.info('Intel', `Pruned ${pruned} expired fingerprint cache entries`);

  return reset;
}
```

Imports for `resumeJobs.ts`:

```typescript
import { pruneCache } from '../../../services/apiCache.js';
import { FINGERPRINT_TTL_MS } from '../../../services/blizzard.js';
```

- [ ] **Step 4: Wire it into `ready.ts`**

In `src/events/ready.ts`, alongside the other registrations (after the `dailyBackup` cron, before `scheduler.start()`):

```typescript
scheduler.registerInterval({
  name: 'resumeApplicantIntelJobs',
  intervalMs: 5 * 60_000,
  handler: () => resumeApplicantIntelJobs(client).then(() => undefined),
});
```

and next to `resumeSessions` (line 125):

```typescript
recoverInterruptedJobs();
```

with the import:

```typescript
import {
  resumeApplicantIntelJobs,
  recoverInterruptedJobs,
} from '../functions/applications/intel/resumeJobs.js';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/intelResumeJobs.test.ts && npx vitest run && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
npx prettier --write src/functions/applications/intel/resumeJobs.ts src/events/ready.ts tests/unit/intelResumeJobs.test.ts
git add src/functions/applications/intel/resumeJobs.ts src/events/ready.ts tests/unit/intelResumeJobs.test.ts
git commit -m "feat(intel): resume due jobs on a schedule and recover after a crash"
```

---

### Task 18: Durable pagination for the found-characters embed

**Files:**

- Create: `src/interactions/intelPagination.ts`
- Modify: `src/interactions/registry.ts` (register the new handler beside the existing `page` one)
- Test: `tests/unit/intelPagination.test.ts`

**Interfaces:**

- Consumes: `getFindings` (Task 5), `renderFoundCharacters` (Task 12), `buildPageButtons` (existing `src/functions/pagination.ts`)
- Produces: `buildIntelPage(jobId: number, page: number, applicantName: string, region: string): { description: string; page: number; totalPages: number } | null`; a `buttons` export with prefix `intelpage`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/intelPagination.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { closeDatabase, getDatabase } from '../../src/database/db.js';
import { createTables } from '../../src/database/schema.js';

vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createJob, addFinding } from '../../src/functions/applications/intel/jobStore.js';
import { buildIntelPage } from '../../src/interactions/intelPagination.js';

const character = { region: 'eu', realm: 'draenor', name: 'Regnipaw' };

describe('buildIntelPage', () => {
  let jobId: number;
  beforeEach(() => {
    process.env.DATABASE_PATH = ':memory:';
    createTables(getDatabase());
    jobId = createJob({ applicationId: 1, targetChannelId: 'c', character });
    for (let i = 0; i < 80; i++) {
      addFinding(jobId, {
        name: `Alt${i}`,
        realm: 'Draenor',
        className: 'Monk',
        guildName: 'Rancour',
        guildRealm: 'Draenor',
        source: 'fingerprint',
        confidence: 50,
      });
    }
  });
  afterEach(() => closeDatabase());

  it('rebuilds a page from the database, not a cache', () => {
    const page = buildIntelPage(jobId, 2, 'Regnipaw', 'eu')!;
    expect(page.page).toBe(2);
    expect(page.totalPages).toBeGreaterThan(1);
    expect(page.description.length).toBeGreaterThan(0);
  });

  it('returns null for a page out of range', () => {
    expect(buildIntelPage(jobId, 99, 'Regnipaw', 'eu')).toBeNull();
  });

  it('returns null for an unknown job', () => {
    expect(buildIntelPage(999_999, 1, 'Regnipaw', 'eu')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/intelPagination.test.ts`
Expected: FAIL — cannot resolve the module

- [ ] **Step 3: Implement**

Create `src/interactions/intelPagination.ts`:

```typescript
import { MessageFlags, EmbedBuilder, Colors } from 'discord.js';
import type { ButtonInteraction } from 'discord.js';
import type { ButtonHandler } from './registry.js';
import { getFindings, getJob } from '../functions/applications/intel/jobStore.js';
import { renderFoundCharacters } from '../functions/applications/intel/render.js';
import { buildPageButtons } from '../functions/pagination.js';

/**
 * Pages are rebuilt from applicant_intel_findings on demand rather than from
 * the 5-minute in-memory cache behind the generic `page:` handler: an
 * application thread is read days later, and "run the command again" is not
 * something a reviewer can act on there.
 */
export function buildIntelPage(
  jobId: number,
  page: number,
  applicantName: string,
  region: string,
): { description: string; page: number; totalPages: number } | null {
  const findings = getFindings(jobId);
  if (findings.length === 0) return null;
  const pages = renderFoundCharacters(findings, applicantName, region);
  const index = page - 1;
  if (index < 0 || index >= pages.length) return null;
  return { description: pages[index], page, totalPages: pages.length };
}

async function handleIntelPage(interaction: ButtonInteraction, params: string[]): Promise<void> {
  // customId: intelpage:{jobId}:{page}
  const jobId = Number(params[0]);
  const page = Number(params[1]);
  const job = getJob(jobId);
  const built = job ? buildIntelPage(jobId, page, job.character_name, job.character_region) : null;

  if (!built) {
    await interaction.reply({
      content: 'That character list is no longer available.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const embed = new EmbedBuilder().setColor(Colors.Green).setDescription(built.description);
  if (built.totalPages > 1) {
    embed.setFooter({ text: `Page ${built.page}/${built.totalPages}` });
  }
  const buttonsRow = buildPageButtons(`intelpage:${jobId}`, built.page, built.totalPages);
  await interaction.update({ embeds: [embed], components: buttonsRow ? [buttonsRow] : [] });
}

export const buttons: ButtonHandler[] = [{ prefix: 'intelpage', handle: handleIntelPage }];
```

In `src/interactions/registry.ts`, register this module's `buttons` exactly the way the existing `pagination.js` buttons are registered — import and spread it into the same collection. Leave the cache-backed `page:` handler untouched.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/intelPagination.test.ts && npx vitest run && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/interactions/intelPagination.ts src/interactions/registry.ts tests/unit/intelPagination.test.ts
git add src/interactions/intelPagination.ts src/interactions/registry.ts tests/unit/intelPagination.test.ts
git commit -m "feat(intel): add durable pagination for the found-characters embed"
```

---

### Task 19: `/test applicant_intel` subcommand

**Files:**

- Modify: `src/commands/test.ts` (subcommand builder around line 282, handler around line 328)
- Test: `tests/unit/testApplicantIntel.test.ts`

**Interfaces:**

- Consumes: `collectRaiderIoCharacters` (Task 1), `placeholderEmbed` + `startIntelJob` (Task 16)
- Produces: `parseIntelUrls(raw: string): RaiderIoCharacter[]` exported from `src/commands/test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/testApplicantIntel.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseIntelUrls } from '../../src/commands/test.js';

describe('parseIntelUrls', () => {
  it('parses a single URL', () => {
    expect(parseIntelUrls('https://raider.io/characters/eu/draenor/Brentpriest')).toEqual([
      { region: 'eu', realm: 'draenor', name: 'Brentpriest' },
    ]);
  });

  it('parses several space-separated URLs', () => {
    const parsed = parseIntelUrls(
      'https://raider.io/characters/eu/draenor/Brentpriest https://raider.io/characters/eu/draenor/Brenthunter',
    );
    expect(parsed.map((c) => c.name)).toEqual(['Brentpriest', 'Brenthunter']);
  });

  it('returns an empty array for input with no character URL', () => {
    expect(parseIntelUrls('not a url')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/testApplicantIntel.test.ts`
Expected: FAIL — `parseIntelUrls` is not exported

- [ ] **Step 3: Implement**

In `src/commands/test.ts`, add near the other helpers:

```typescript
import {
  collectRaiderIoCharacters,
  type RaiderIoCharacter,
} from '../functions/applications/raiderIoName.js';
import { placeholderEmbed, startIntelJob } from '../functions/applications/intel/placeholders.js';

/** Accepts one or more space-separated Raider.IO character URLs, parsed the
 *  same way application answers are so a bad URL fails identically. */
export function parseIntelUrls(raw: string): RaiderIoCharacter[] {
  return collectRaiderIoCharacters([{ answer: raw }]);
}
```

Register the subcommand alongside `clear_channel`:

```typescript
    .addSubcommand((sub) =>
      sub
        .setName('applicant_intel')
        .setDescription('Run the applicant intel sweep and post the results in this channel')
        .addStringOption((opt) =>
          opt
            .setName('url')
            .setDescription('Raider.IO character URL(s), space-separated')
            .setRequired(true),
        ),
    ),
```

and handle it in `execute`, following the existing `deferReply` / `audit` / `editReply` shape:

```typescript
if (sub === 'applicant_intel') {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const characters = parseIntelUrls(interaction.options.getString('url', true));
  if (characters.length === 0) {
    await interaction.editReply({
      content: 'No Raider.IO character URL found in that input.',
    });
    return;
  }

  const channel = interaction.channel;
  if (!channel || !channel.isTextBased() || !('send' in channel)) {
    await interaction.editReply({ content: 'This channel cannot receive messages.' });
    return;
  }

  // Same placeholders as a real application, so the runner exercises the
  // production edit path rather than a test-only renderer.
  const altsMessage = await channel.send({ embeds: [placeholderEmbed('alts')] });
  const logsMessage = await channel.send({ embeds: [placeholderEmbed('logs')] });

  const jobId = startIntelJob({
    applicationId: null,
    targetChannelId: channel.id,
    character: characters[0],
    altsMessageId: altsMessage.id,
    logsMessageId: logsMessage.id,
  });

  await audit(
    interaction.user,
    'ran applicant intel',
    `${characters[0].name}-${characters[0].realm} (job #${jobId})`,
  );
  await interaction.editReply({
    content:
      `Started intel job #${jobId} for **${characters[0].name}**-${characters[0].realm}. ` +
      'The two messages above will fill in as the sweep completes (up to a few minutes).',
  });
  return;
}
```

The job is picked up by the scheduler tick like any other, so pauses, resumes and the rate-limited footer all behave exactly as they do for a real application. The command inherits `devOnly: true` (skipped in production by `deploy-commands.ts:32`), the `Administrator` default permission, and the `requireOfficer` check at the top of `execute`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/testApplicantIntel.test.ts && npx vitest run && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/commands/test.ts tests/unit/testApplicantIntel.test.ts
git add src/commands/test.ts tests/unit/testApplicantIntel.test.ts
git commit -m "feat(test): add /test applicant_intel to run the sweep in-channel"
```

---

### Task 20: Full verification

**Files:**

- Modify: `README.md` (only if it lists commands or scheduled tasks — check first)
- Test: whole suite

- [ ] **Step 1: Run the full suite, types and formatting**

```bash
npx vitest run
npx tsc --noEmit
npm run lint
npx prettier --check .
```

Expected: all green. A prettier failure blocks the Railway deploy even when eslint passes, so do not skip the last one.

- [ ] **Step 2: Confirm no new environment variables were introduced**

```bash
git diff main --stat -- src/config.ts
grep -n "required(" src/config.ts | wc -l
```

Expected: `src/config.ts` unchanged. If it did change, `.github/workflows/ci.yml`'s stub block must gain the new variable, or whole test files silently drop out of the run.

- [ ] **Step 3: Verify the migration on a copy of the live database**

```bash
cp db.sqlite /tmp/verify-v11.sqlite
DATABASE_PATH=/tmp/verify-v11.sqlite npx vitest run tests/unit/intelJobStore.test.ts
node -e "const d=require('better-sqlite3')('/tmp/verify-v11.sqlite',{readonly:true});console.log('version',d.prepare('SELECT MAX(version) v FROM schema_version').get().v);console.log(d.prepare(\"SELECT name FROM sqlite_master WHERE name LIKE 'applicant_intel%' ORDER BY name\").all().map(r=>r.name).join(', '));"
```

Expected: `version 11` and all four `applicant_intel_*` tables, with pre-existing tables intact.

- [ ] **Step 4: Update the README if it enumerates commands or scheduled tasks**

```bash
grep -n "clear_channel\|dailyBackup\|scheduled" README.md | head
```

If `/test` subcommands or scheduled tasks are listed, add `applicant_intel` and `resumeApplicantIntelJobs`. If not, skip — do not invent a section.

- [ ] **Step 5: Manual smoke test against the live bot**

This is the only way to confirm masked links render, since masked links do **not** parse in plain message content and pasting the markdown by hand will always look broken:

1. Deploy to the test bot and run in a test channel:
   `/test applicant_intel url:https://raider.io/characters/eu/draenor/Brentpriest`
2. Confirm two placeholder embeds post immediately and the ephemeral reply names a job id.
3. Within ~5 minutes (the scheduler tick), confirm both embeds fill in.
4. Check that character names are clickable and report links are clickable.
5. Expect attribution across several characters — that account's first kills are split between `Brentprietwo` and `Brenthunter`, and the applicant's own `Brentpriest` holds the Nerub'ar Palace lines.
6. Re-run the same command and confirm the second sweep is visibly faster and the cache is populated. This is the only check that the entity-keyed caching actually works end to end:

   ```bash
   railway ssh "node" <<'EOF'
   const db = require('better-sqlite3')(process.env.DB_PATH, { readonly: true });
   const q = (p) => db.prepare("SELECT COUNT(*) n FROM api_cache WHERE key LIKE ?").get(p).n;
   console.log('fingerprints', q('fingerprint:%'), 'rosters', q('guild-roster:%'));
   EOF
   ```

   Expected: both counts non-zero after the first run, and the second run adds few or none for the same guilds.

- [ ] **Step 6: Commit any documentation change**

```bash
npx prettier --write README.md
git add README.md
git commit -m "docs: note the applicant intel command and scheduled task"
```

Skip this commit entirely if Step 4 found nothing to change.

---

## Notes for the implementer

- **Never call `getGuildRoster()` for someone else's guild.** It is hardcoded to our own guild and filters to `ROSTER_RANKS`. Task 8 adds `getFullGuildRoster(name, realm)` for the sweep — unfiltered and cached — and the adapter in Task 15 wires it. Reaching for the existing function here reintroduces a truncated-roster false negative that looks identical to "no alts found".
- **The caches are keyed by entity, so they outlive the job.** A fingerprint is keyed by character and a roster by guild, which is what makes a second applicant from the same guild cheap. Do not move either into the job tables to make resume simpler — `applicant_intel_scanned` already covers resume, and job-scoping the data would restore the full request cost on every sweep.
- **Raider.IO tier ordinals** are numeric and were verified live: `35` current, `34` Manaforge Omega, `33` Liberation of Undermine, `30` Aberrus. They shift when a tier is added — the constant lives in `resumeJobs.ts`.
- **Do not "fix" the wipe path to use `playerDetails`.** It answers per pull; a single boss had 43 pulls in one night. `friendlyPlayers` + `masterData.actors` answers for the whole report in one query.
- **Keep the services and pure functions free of `discord.js` imports.** They already are, for testability. It also happens to be the seam along which this feature could later become a standalone service — only `runJob.ts`'s message editing, the two renderers and `intelPagination.ts` are Discord-bound. Not a goal of this plan, but cheap to preserve and expensive to recover once a `Client` leaks into the sweep.
- **Never let a failed fetch mean "no data".** `getMythicKillDates` returns `null` for unknown, `getCharacterFingerprint` returns `null` for unavailable, and both must stay distinct from an empty result.

# Quip Generation v3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rotate the three quip LLM providers daily, log which model produced each quip, and enrich quips with raid progression, personas, memes (search-grounded), unsigned counts, and anti-repetition memory.

**Architecture:** All provider logic stays in `src/services/quipGenerator.ts` (raw `fetch`, no SDKs). A new DB/API-free-testable helper module `src/services/quipContext.ts` derives raid progression from raider.io. Quip history lives in a new `quip_history` table with helpers in `src/functions/raids/quipHistory.ts`. `alertSignups.ts` wires everything together.

**Tech Stack:** TypeScript (Node16 modules — all relative imports end in `.js`), vitest, better-sqlite3, raw `fetch` + `AbortController`.

**Spec:** `docs/superpowers/specs/2026-07-20-quip-generation-v3-design.md`

## Global Constraints

- No new npm dependencies. Raw `fetch` for all provider calls.
- `quipGenerator.ts` must stay free of DB and raider.io imports (unit-testable with only `fetch` mocked).
- The quip path must never throw to the caller and never block on raider.io — every failure degrades to the static corpus / omitted context.
- Existing exports keep working except `generateSignupQuip`'s return type, which changes deliberately (Task 1).
- Run all commands from `G:\repos\SeriouslyCasualBotV2`. Test command: `npx vitest run tests/unit/<file>.test.ts`. Build: `npm run build`.
- Do NOT push to `origin develop` — pushing auto-deploys the test bot. Commit locally only.

---

### Task 1: `generateSignupQuip` returns `{ quip, generated }`

The history feature (Task 7/8) must distinguish LLM-generated quips from static fallbacks. Change the return type now so every later task builds on the final signature.

**Files:**
- Modify: `src/services/quipGenerator.ts`
- Modify: `src/functions/raids/alertSignups.ts` (call site, ~line 124)
- Test: `tests/unit/quipGenerator.test.ts`

**Interfaces:**
- Produces: `export interface QuipResult { quip: string; generated: boolean }`; `generateSignupQuip(options: GenerateQuipOptions): Promise<QuipResult>`. `generated` is `true` when an LLM produced the quip, `false` for the static corpus.

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/quipGenerator.test.ts`:

```typescript
it('marks static-corpus fallback with generated: false', async () => {
  delete process.env.GEMINI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;

  const result = await generateSignupQuip({ raidDay: 'Wednesday', twoDayReminder: false });
  expect(result.generated).toBe(false);
  expect(result.quip.length).toBeGreaterThan(0);
});

it('marks LLM quips with generated: true', async () => {
  process.env.GEMINI_API_KEY = 'test-key';

  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: 'Sign up!' }] } }],
    }),
    text: async () => '',
  })) as unknown as typeof fetch;

  const result = await generateSignupQuip({ raidDay: 'Sunday', twoDayReminder: false });
  expect(result.generated).toBe(true);
  expect(result.quip).toBe('Sign up!');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/quipGenerator.test.ts`
Expected: the two new tests FAIL (`result.generated` is `undefined` because the function returns a string). Pre-existing tests still pass.

- [ ] **Step 3: Change the return type**

In `src/services/quipGenerator.ts`:

```typescript
export interface QuipResult {
  quip: string;
  generated: boolean;
}
```

Change the signature to `export async function generateSignupQuip(options: GenerateQuipOptions): Promise<QuipResult>`, the success return (currently `return cleaned;`) to `return { quip: cleaned, generated: true };`, and the final fallback (currently `return randomFallback();`) to `return { quip: randomFallback(), generated: false };`.

- [ ] **Step 4: Update every existing test that reads the return value**

Mechanical: each existing test does `const quip = await generateSignupQuip(...)` and asserts on `quip`. Rename the variable and assert on `.quip`, e.g.:

```typescript
// before
const quip = await generateSignupQuip({ raidDay: 'Sunday', twoDayReminder: true });
expect(quip).toBe('Stop standing in fire — sign up!');
// after
const result = await generateSignupQuip({ raidDay: 'Sunday', twoDayReminder: true });
expect(result.quip).toBe('Stop standing in fire — sign up!');
```

Tests that only assert `typeof quip === 'string'` become `typeof result.quip === 'string'`.

- [ ] **Step 5: Update the call site in `alertSignups.ts`**

```typescript
// before (~line 124)
const randomMessage = await generateSignupQuip({
  raidDay: dayConfig.raidDay,
  twoDayReminder: dayConfig.twoDayReminder,
  overlordNames,
});
// after
const { quip } = await generateSignupQuip({
  raidDay: dayConfig.raidDay,
  twoDayReminder: dayConfig.twoDayReminder,
  overlordNames,
});
```

And change the one use of `randomMessage` (~line 131) to `quip`.

- [ ] **Step 6: Run tests and build**

Run: `npx vitest run tests/unit/quipGenerator.test.ts` → all pass.
Run: `npm run build` → exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/services/quipGenerator.ts src/functions/raids/alertSignups.ts tests/unit/quipGenerator.test.ts
git commit -m "refactor(quips): return { quip, generated } from generateSignupQuip"
```

---

### Task 2: Daily provider rotation

**Files:**
- Modify: `src/services/quipGenerator.ts`
- Test: `tests/unit/quipGenerator.test.ts`

**Interfaces:**
- Consumes: `PROVIDERS` array (`Gemini`, `OpenAI`, `Claude` order) already in the file.
- Produces: `GenerateQuipOptions` gains optional `now?: Date` (defaults to `new Date()`); the cascade starts at `PROVIDERS[dayOfYear(now) % 3]` and wraps. Nothing else changes for callers.

Rotation is date-derived (not an in-memory counter) because every deploy restarts the bot, which would reset a counter to Gemini. Useful pinned dates (UTC): `2026-01-03` → day 3 → Gemini first; `2026-01-04` → OpenAI first; `2026-01-05` → Claude first.

- [ ] **Step 1: Write the failing tests**

Add near the top of the describe block in `tests/unit/quipGenerator.test.ts`:

```typescript
const GEMINI_FIRST = new Date('2026-01-03T12:00:00Z');
const OPENAI_FIRST = new Date('2026-01-04T12:00:00Z');
const CLAUDE_FIRST = new Date('2026-01-05T12:00:00Z');

function mockAllProvidersOk(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string) => ({
    ok: true,
    json: async () => {
      if (url.includes('generativelanguage.googleapis.com')) {
        return { candidates: [{ content: { parts: [{ text: 'gemini quip' }] } }] };
      }
      if (url.includes('api.openai.com')) {
        return { choices: [{ message: { content: 'openai quip' } }] };
      }
      return { content: [{ type: 'text', text: 'claude quip' }] };
    },
    text: async () => '',
  }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function setAllKeys(): void {
  process.env.GEMINI_API_KEY = 'g-key';
  process.env.OPENAI_API_KEY = 'o-key';
  process.env.ANTHROPIC_API_KEY = 'a-key';
}
```

Then the tests:

```typescript
it('rotates the starting provider by day of year', async () => {
  setAllKeys();
  mockAllProvidersOk();
  expect((await generateSignupQuip({ raidDay: 'Sunday', twoDayReminder: false, now: GEMINI_FIRST })).quip).toBe('gemini quip');
  expect((await generateSignupQuip({ raidDay: 'Sunday', twoDayReminder: false, now: OPENAI_FIRST })).quip).toBe('openai quip');
  expect((await generateSignupQuip({ raidDay: 'Sunday', twoDayReminder: false, now: CLAUDE_FIRST })).quip).toBe('claude quip');
});

it('falls through in rotated order when the first provider fails', async () => {
  setAllKeys();
  const fetchMock = vi.fn(async (url: string) => {
    if (url.includes('api.anthropic.com')) {
      return { ok: false, status: 500, json: async () => ({}), text: async () => 'boom' };
    }
    return {
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'gemini quip' }] } }] }),
      text: async () => '',
    };
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  // Claude-first day: Claude fails, Gemini (next in rotation) wins.
  const result = await generateSignupQuip({ raidDay: 'Sunday', twoDayReminder: false, now: CLAUDE_FIRST });
  expect(result.quip).toBe('gemini quip');
  expect((fetchMock.mock.calls[0][0] as string)).toContain('api.anthropic.com');
});
```

- [ ] **Step 2: Pin the date in existing order-sensitive tests**

Every existing test that assumes Gemini goes first must pass `now: GEMINI_FIRST` in its options — otherwise it becomes flaky depending on the day the suite runs. That is every test that: asserts which provider's mock answer came back, inspects `fetchMock.mock.calls[0]`, or counts fetch calls. This includes `'returns the Gemini response when the API call succeeds'`, `'calls Gemini via the flash-lite-latest alias'`, `'uses OpenAI when Gemini fails'`, `'skips providers with unset keys'`, `'uses Claude when Gemini and OpenAI both fail'`, and the quote/list/length-normalisation tests (they assert on the Gemini-shaped mock). Example:

```typescript
const result = await generateSignupQuip({ raidDay: 'Sunday', twoDayReminder: true, now: GEMINI_FIRST });
```

- [ ] **Step 3: Run tests to verify the new ones fail**

Run: `npx vitest run tests/unit/quipGenerator.test.ts`
Expected: new rotation tests FAIL (`now` is not a known option / order never changes). Existing tests pass.

- [ ] **Step 4: Implement rotation**

In `src/services/quipGenerator.ts`, add `now?: Date` to `GenerateQuipOptions`:

```typescript
export interface GenerateQuipOptions {
  raidDay: string;
  twoDayReminder: boolean;
  /** Names of the guild's Overlords to optionally reference. Empty = no name reference. */
  overlordNames?: string[];
  /** Clock override so tests can pin the provider rotation. */
  now?: Date;
}
```

Below the `PROVIDERS` array:

```typescript
// Rotate the starting provider daily so the guild hears all three model
// voices. Derived from the date (not a counter) because every deploy
// restarts the bot, which would reset a counter back to Gemini.
function dayOfYear(date: Date): number {
  const startOfYear = Date.UTC(date.getUTCFullYear(), 0, 0);
  return Math.floor((date.getTime() - startOfYear) / 86_400_000);
}

function rotatedProviders(date: Date): QuipProvider[] {
  const offset = dayOfYear(date) % PROVIDERS.length;
  return [...PROVIDERS.slice(offset), ...PROVIDERS.slice(0, offset)];
}
```

In `generateSignupQuip`, replace `for (const provider of PROVIDERS)` with:

```typescript
const providers = rotatedProviders(options.now ?? new Date());
for (const provider of providers) {
```

Also update the JSDoc above `generateSignupQuip` (it currently says "tries each provider in `PROVIDERS` in order (Gemini, then OpenAI, then Claude)") to describe the daily rotation.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/unit/quipGenerator.test.ts`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/services/quipGenerator.ts tests/unit/quipGenerator.test.ts
git commit -m "feat(quips): rotate starting LLM provider by day of year"
```

---

### Task 3: Log the model that produced each quip

**Files:**
- Modify: `src/services/quipGenerator.ts`
- Test: `tests/unit/quipGenerator.test.ts`

**Interfaces:**
- Consumes: `logger` from `src/services/logger.js` (`logger.info(context: string, message: string)` — same shape as the existing `logger.warn` calls in this file).
- Produces: internal only. Provider `call` functions now return `ProviderResult { text: string | null; resolvedModel: string | null }`; each `PROVIDERS` entry gains `model: string`. Success logs at `info`: `` `Quip generated via ${name} (${resolvedModel ?? model})` ``. Fallback logs at `info`: `Quip fallback: static V1 corpus`.

- [ ] **Step 1: Write the failing tests**

```typescript
it('logs the resolved model name at info on success', async () => {
  setAllKeys();
  const infoSpy = vi.spyOn(logger, 'info');
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: 'Sign up!' }] } }],
      modelVersion: 'gemini-3.1-flash-lite',
    }),
    text: async () => '',
  })) as unknown as typeof fetch;

  await generateSignupQuip({ raidDay: 'Sunday', twoDayReminder: false, now: GEMINI_FIRST });
  expect(infoSpy).toHaveBeenCalledWith('QuipGen', 'Quip generated via Gemini (gemini-3.1-flash-lite)');
});

it('logs the static fallback at info', async () => {
  delete process.env.GEMINI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const infoSpy = vi.spyOn(logger, 'info');

  await generateSignupQuip({ raidDay: 'Sunday', twoDayReminder: false });
  expect(infoSpy).toHaveBeenCalledWith('QuipGen', 'Quip fallback: static V1 corpus');
});
```

Add the import at the top of the test file: `import { logger } from '../../src/services/logger.js';`

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/quipGenerator.test.ts`
Expected: the two new tests FAIL (no `info` call is made).

- [ ] **Step 3: Implement**

In `src/services/quipGenerator.ts`:

```typescript
interface ProviderResult {
  text: string | null;
  /** Model the API says actually served the request; null if not echoed. */
  resolvedModel: string | null;
}

interface QuipProvider {
  name: string;
  model: string;
  getKey: () => string;
  call: (apiKey: string, prompt: string) => Promise<ProviderResult>;
}

const GEMINI_MODEL = 'gemini-flash-lite-latest';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
```

(Keep the existing alias comment above `GEMINI_MODEL`. Delete the old `GEMINI_ENDPOINT` literal.)

```typescript
const PROVIDERS: QuipProvider[] = [
  { name: 'Gemini', model: GEMINI_MODEL, getKey: () => config.geminiApiKey, call: callGemini },
  { name: 'OpenAI', model: OPENAI_MODEL, getKey: () => config.openaiApiKey, call: callOpenAI },
  { name: 'Claude', model: ANTHROPIC_MODEL, getKey: () => config.anthropicApiKey, call: callClaude },
];
```

(`OPENAI_MODEL` / `ANTHROPIC_MODEL` are declared below `PROVIDERS` in the current file — hoisting is fine for `const` used inside functions, but `PROVIDERS` initialises at module load, so move the three model consts above `PROVIDERS`.)

Provider changes — each `callX` returns `ProviderResult` instead of `string | null`:

- `callGemini`: add `modelVersion?: string` to `GeminiResponse`; final returns become `return { text: null, resolvedModel: json.modelVersion ?? null };` and `return { text, resolvedModel: json.modelVersion ?? null };`
- `callOpenAI`: add `model?: string` to `OpenAIResponse`; returns become `{ text: null, resolvedModel: json.model ?? null }` / `{ text, resolvedModel: json.model ?? null }`
- `callClaude`: add `model?: string` to `AnthropicResponse`; same shape.

Orchestrator loop:

```typescript
const result = await provider.call(apiKey, prompt);
if (!result.text) continue;

const cleaned = normalizeQuip(result.text);
if (cleaned.length === 0 || cleaned.length > MAX_QUIP_LENGTH) {
  logger.warn(
    'QuipGen',
    `${provider.name} quip rejected (length ${cleaned.length}): ${cleaned.slice(0, 80)}`,
  );
  continue;
}

logger.info('QuipGen', `Quip generated via ${provider.name} (${result.resolvedModel ?? provider.model})`);
return { quip: cleaned, generated: true };
```

And before the final fallback return:

```typescript
logger.info('QuipGen', 'Quip fallback: static V1 corpus');
return { quip: randomFallback(), generated: false };
```

- [ ] **Step 4: Run tests and build**

Run: `npx vitest run tests/unit/quipGenerator.test.ts` → all pass.
Run: `npm run build` → exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/services/quipGenerator.ts tests/unit/quipGenerator.test.ts
git commit -m "feat(quips): log which model produced each quip at info level"
```

---

### Task 4: Progression context from raider.io

**Files:**
- Create: `src/services/quipContext.ts`
- Test: `tests/unit/quipContext.test.ts`

**Interfaces:**
- Consumes: `getRaidStaticData(expansionId)`, `getRaidRankings(slug)` from `src/services/raiderio.js`; `logger` from `src/services/logger.js`.
- Produces:

```typescript
export interface ProgressionContext {
  mode: 'progress' | 'reclear';
  raidName: string;
  /** In 'progress' mode: the current prog boss. In 'reclear' mode: the dead end boss. */
  bossName: string;
  killed: number;
  total: number;
}
export async function getProgressionContext(): Promise<ProgressionContext | null>;
```

Never throws; returns `null` on any API failure, missing raid, or empty rankings.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/quipContext.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { getProgressionContext } from '../../src/services/quipContext.js';
import * as raiderio from '../../src/services/raiderio.js';

vi.mock('../../src/services/raiderio.js');

const mockedStatic = vi.mocked(raiderio.getRaidStaticData);
const mockedRankings = vi.mocked(raiderio.getRaidRankings);

const ENCOUNTERS = [
  { id: 1, slug: 'boss-one', name: 'Boss One' },
  { id: 2, slug: 'boss-two', name: 'Boss Two' },
  { id: 3, slug: 'the-end-boss', name: 'The End Boss' },
];

function staticDataWithCurrentRaid() {
  return {
    raids: [
      {
        id: 1, slug: 'old-raid', name: 'Old Raid', expansion_id: 10,
        starts: { us: '2025-01-01', eu: '2025-01-01' },
        ends: { us: '2025-06-01', eu: '2025-06-01' },
        encounters: ENCOUNTERS,
      },
      {
        id: 2, slug: 'current-raid', name: 'Current Raid', expansion_id: 10,
        starts: { us: '2026-01-01', eu: '2026-01-01' },
        ends: { us: null, eu: null },
        encounters: ENCOUNTERS,
      },
    ],
  };
}

afterEach(() => {
  vi.resetAllMocks();
});

describe('getProgressionContext', () => {
  it('returns the current prog boss when not all bosses are dead', async () => {
    mockedStatic.mockResolvedValueOnce(staticDataWithCurrentRaid());
    mockedStatic.mockRejectedValueOnce(new Error('400 no such expansion'));
    mockedRankings.mockResolvedValueOnce([
      { rank: 123, guild: { name: 'seriouslycasual', realm: 'silvermoon', region: 'eu' }, encountersDefeated: 2, encountersTotal: 3 },
    ]);

    const ctx = await getProgressionContext();
    expect(ctx).toEqual({
      mode: 'progress',
      raidName: 'Current Raid',
      bossName: 'The End Boss',
      killed: 2,
      total: 3,
    });
  });

  it('returns reclear mode when the end boss is dead', async () => {
    mockedStatic.mockResolvedValueOnce(staticDataWithCurrentRaid());
    mockedStatic.mockRejectedValueOnce(new Error('400 no such expansion'));
    mockedRankings.mockResolvedValueOnce([
      { rank: 45, guild: { name: 'seriouslycasual', realm: 'silvermoon', region: 'eu' }, encountersDefeated: 3, encountersTotal: 3 },
    ]);

    const ctx = await getProgressionContext();
    expect(ctx).toEqual({
      mode: 'reclear',
      raidName: 'Current Raid',
      bossName: 'The End Boss',
      killed: 3,
      total: 3,
    });
  });

  it('returns null when rankings are empty (fresh tier)', async () => {
    mockedStatic.mockResolvedValueOnce(staticDataWithCurrentRaid());
    mockedStatic.mockRejectedValueOnce(new Error('400 no such expansion'));
    mockedRankings.mockResolvedValueOnce([]);

    expect(await getProgressionContext()).toBeNull();
  });

  it('returns null when the static-data API fails outright', async () => {
    mockedStatic.mockRejectedValue(new Error('raider.io down'));

    expect(await getProgressionContext()).toBeNull();
  });

  it('skips Fated/Awakened raids when finding the current raid', async () => {
    const data = staticDataWithCurrentRaid();
    data.raids.push({
      id: 3, slug: 'fated-current-raid', name: 'Fated Current Raid', expansion_id: 10,
      starts: { us: '2026-01-01', eu: '2026-01-01' },
      ends: { us: null, eu: null },
      encounters: ENCOUNTERS,
    });
    mockedStatic.mockResolvedValueOnce(data);
    mockedStatic.mockRejectedValueOnce(new Error('400 no such expansion'));
    mockedRankings.mockResolvedValueOnce([
      { rank: 1, guild: { name: 'seriouslycasual', realm: 'silvermoon', region: 'eu' }, encountersDefeated: 1, encountersTotal: 3 },
    ]);

    const ctx = await getProgressionContext();
    expect(ctx?.raidName).toBe('Current Raid');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/quipContext.test.ts`
Expected: FAIL — module `src/services/quipContext.ts` does not exist.

- [ ] **Step 3: Implement `src/services/quipContext.ts`**

```typescript
import { getRaidStaticData, getRaidRankings } from './raiderio.js';
import { logger } from './logger.js';

// Same walk checkRaidExpansions uses: raider.io static data has no "current
// expansion" endpoint, so probe upward from a known floor until the API 400s.
const START_EXPANSION = 9;

export interface ProgressionContext {
  mode: 'progress' | 'reclear';
  raidName: string;
  /** In 'progress' mode: the current prog boss. In 'reclear' mode: the dead end boss. */
  bossName: string;
  killed: number;
  total: number;
}

/**
 * Derive the guild's current Mythic progression from raider.io for quip
 * flavour. Best-effort only: any API failure, missing current raid, or empty
 * rankings (fresh tier) returns null — the quip must never fail or block on
 * raider.io.
 */
export async function getProgressionContext(): Promise<ProgressionContext | null> {
  try {
    const currentRaid = await findCurrentRaid();
    if (!currentRaid) {
      logger.debug('QuipContext', 'No current raid found in static data');
      return null;
    }

    const rankings = await getRaidRankings(currentRaid.slug);
    if (!rankings || rankings.length === 0) {
      logger.debug('QuipContext', `No rankings for ${currentRaid.slug} (fresh tier?)`);
      return null;
    }

    // encountersDefeated is typed as a number but the API has been observed
    // returning an array — same guard as updateAchievements.
    const defeatedCount = (entry: (typeof rankings)[number]): number => {
      const val = entry.encountersDefeated as unknown;
      if (Array.isArray(val)) return val.length;
      if (typeof val === 'number') return val;
      return 0;
    };

    const best = rankings.reduce((a, b) => (defeatedCount(b) > defeatedCount(a) ? b : a), rankings[0]);
    const killed = defeatedCount(best);
    const total =
      typeof best.encountersTotal === 'number' && best.encountersTotal > 0
        ? best.encountersTotal
        : currentRaid.encounters.length;

    if (killed >= total) {
      const endBoss = currentRaid.encounters[currentRaid.encounters.length - 1];
      if (!endBoss) return null;
      return { mode: 'reclear', raidName: currentRaid.name, bossName: endBoss.name, killed, total };
    }

    // Static-data encounters are in kill order, so the prog boss is the
    // first undefeated one.
    const progBoss = currentRaid.encounters[killed];
    if (!progBoss) return null;
    return { mode: 'progress', raidName: currentRaid.name, bossName: progBoss.name, killed, total };
  } catch (err) {
    logger.debug(
      'QuipContext',
      `Progression lookup failed, omitting context: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

type StaticRaid = Awaited<ReturnType<typeof getRaidStaticData>>['raids'][number];

async function findCurrentRaid(): Promise<StaticRaid | null> {
  let expansion = START_EXPANSION;
  let currentRaid: StaticRaid | null = null;

  // Keep scanning until the API errors (unknown expansion) so we end up with
  // the newest expansion's current tier, not an old expansion's.
  for (;;) {
    let staticData;
    try {
      staticData = await getRaidStaticData(expansion);
    } catch {
      break;
    }

    const now = Date.now();
    const candidates = (staticData.raids ?? [])
      .filter((r) => !r.name.startsWith('Fated') && !r.name.startsWith('Awakened'))
      .sort((a, b) => {
        const aEnd = a.ends.eu ? new Date(a.ends.eu).getTime() : Infinity;
        const bEnd = b.ends.eu ? new Date(b.ends.eu).getTime() : Infinity;
        return aEnd - bEnd;
      });
    const found = candidates.find((r) => r.ends.eu === null || new Date(r.ends.eu).getTime() > now);
    if (found) currentRaid = found;

    expansion++;
  }

  return currentRaid;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/quipContext.test.ts`
Expected: all 5 pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/quipContext.ts tests/unit/quipContext.test.ts
git commit -m "feat(quips): derive raid progression context from raider.io"
```

---

### Task 5: Prompt enrichment (persona, count, progression, memes, history)

**Files:**
- Modify: `src/services/quipGenerator.ts`
- Test: `tests/unit/quipGenerator.test.ts`

**Interfaces:**
- Consumes: `ProgressionContext` type from `src/services/quipContext.js` (type-only import — keeps `quipGenerator` free of raider.io calls).
- Produces: `GenerateQuipOptions` gains `unsignedCount?: number`, `progression?: ProgressionContext | null`, `recentQuips?: string[]`. All optional; omitting them produces a prompt equivalent to today's plus persona/meme/restraint lines.

- [ ] **Step 1: Write the failing tests**

Add a test helper that captures the prompt sent to Gemini, then the tests:

```typescript
async function capturePrompt(options: Parameters<typeof generateSignupQuip>[0]): Promise<string> {
  process.env.GEMINI_API_KEY = 'test-key';
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ candidates: [{ content: { parts: [{ text: 'Sign up!' }] } }] }),
    text: async () => '',
  })) as unknown as typeof fetch;
  globalThis.fetch = fetchMock;

  await generateSignupQuip({ ...options, now: GEMINI_FIRST });
  const body = JSON.parse(
    (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string,
  );
  return body.contents[0].parts[0].text as string;
}

it('always includes a persona, meme licence, and restraint rule in the prompt', async () => {
  const prompt = await capturePrompt({ raidDay: 'Sunday', twoDayReminder: false });
  expect(prompt).toContain('Write in the voice of a ');
  expect(prompt).toContain('classic WoW meme');
  expect(prompt).toContain('at most one or two');
});

it('includes the unsigned count when provided', async () => {
  const prompt = await capturePrompt({ raidDay: 'Sunday', twoDayReminder: false, unsignedCount: 6 });
  expect(prompt).toContain("6 raiders still haven't signed up");
});

it('includes progression context in progress mode', async () => {
  const prompt = await capturePrompt({
    raidDay: 'Sunday',
    twoDayReminder: false,
    progression: { mode: 'progress', raidName: 'Current Raid', bossName: 'The End Boss', killed: 2, total: 3 },
  });
  expect(prompt).toContain('currently progressing The End Boss in Current Raid (2/3M)');
});

it('includes reclear context when the end boss is dead', async () => {
  const prompt = await capturePrompt({
    raidDay: 'Sunday',
    twoDayReminder: false,
    progression: { mode: 'reclear', raidName: 'Current Raid', bossName: 'The End Boss', killed: 3, total: 3 },
  });
  expect(prompt).toContain('Current Raid on farm');
  expect(prompt).toContain('The End Boss is dead');
});

it('omits progression and count lines when not provided', async () => {
  const prompt = await capturePrompt({ raidDay: 'Sunday', twoDayReminder: false, progression: null });
  expect(prompt).not.toContain('progressing');
  expect(prompt).not.toContain('on farm');
  expect(prompt).not.toContain("still haven't signed up");
});

it('lists recent quips with an instruction not to repeat them', async () => {
  const prompt = await capturePrompt({
    raidDay: 'Sunday',
    twoDayReminder: false,
    recentQuips: ['Old quip one', 'Old quip two'],
  });
  expect(prompt).toContain('clearly different');
  expect(prompt).toContain('Old quip one');
  expect(prompt).toContain('Old quip two');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/quipGenerator.test.ts`
Expected: the six new tests FAIL (prompt lacks the new lines). Existing tests pass.

- [ ] **Step 3: Implement**

In `src/services/quipGenerator.ts`, add the type-only import and options:

```typescript
import type { ProgressionContext } from './quipContext.js';

export interface GenerateQuipOptions {
  raidDay: string;
  twoDayReminder: boolean;
  /** Names of the guild's Overlords to optionally reference. Empty = no name reference. */
  overlordNames?: string[];
  /** How many raiders haven't signed up yet. Omitted = no count line. */
  unsignedCount?: number;
  /** Current Mythic progression, or null/omitted to skip the line. */
  progression?: ProgressionContext | null;
  /** Recent quips the model should avoid resembling. */
  recentQuips?: string[];
  /** Clock override so tests can pin the provider rotation. */
  now?: Date;
}
```

Add the persona list near `V1_SAMPLE_QUIPS`:

```typescript
// One is picked at random per alert for variety. Personas are flavour only —
// the restraint rule in the prompt stops the model stacking every element.
const PERSONAS: readonly string[] = [
  'drill sergeant',
  'disappointed parent',
  'greedy loot goblin',
  'condescending gnome engineer',
  'doomsaying shadow priest',
  'overly cheerful holy priest',
  'guild bank goblin accountant',
  'melodramatic bard',
];
```

Replace `buildPrompt` with:

```typescript
function buildPrompt({
  raidDay,
  twoDayReminder,
  overlordNames = [],
  unsignedCount,
  progression,
  recentQuips = [],
}: GenerateQuipOptions): string {
  const examples = V1_SAMPLE_QUIPS.map((q, i) => `${i + 1}. ${q}`).join('\n');
  const reminderNote = twoDayReminder
    ? 'This is the 48-hour early reminder, so a nudge-not-yell tone.'
    : 'This is the day-of reminder, so urgency is fair game.';
  const persona = PERSONAS[Math.floor(Math.random() * PERSONAS.length)];

  const contextLines = [`Context: the next raid is on ${raidDay}. ${reminderNote}`];
  if (typeof unsignedCount === 'number' && unsignedCount > 0) {
    contextLines.push(`${unsignedCount} raiders still haven't signed up.`);
  }
  if (progression) {
    contextLines.push(
      progression.mode === 'progress'
        ? `The guild is currently progressing ${progression.bossName} in ${progression.raidName} (${progression.killed}/${progression.total}M).`
        : `The guild has ${progression.raidName} on farm — ${progression.bossName} is dead, now it's reclear season.`,
    );
  }

  const toneLine =
    overlordNames.length > 0
      ? `Tone: playful, sarcastic, WoW-themed. Occasionally reference the guild's Overlords (${overlordNames.join(', ')}). OK to be cheeky; keep it safe for a shared Discord channel.`
      : 'Tone: playful, sarcastic, WoW-themed. OK to be cheeky; keep it safe for a shared Discord channel.';

  const lines = [
    'You write one-line nudges that a World of Warcraft raiding guild uses to get their raiders to sign up for the next raid.',
    '',
    ...contextLines,
    '',
    toneLine,
    `Write in the voice of a ${persona}.`,
    "You may reference a classic WoW meme (Leeroy Jenkins, 'more dots', 'You are not prepared', 'You face Jaina') or a currently trending internet meme — if you go trending, use web search to find one.",
    "Use at most one or two of these flavour elements (the persona is always on); don't cram everything into one line.",
    '',
    'Examples of the tone:',
    examples,
  ];

  if (recentQuips.length > 0) {
    lines.push('', 'Recent quips — write something clearly different from all of these:');
    lines.push(...recentQuips.map((q, i) => `${i + 1}. ${q}`));
  }

  lines.push('', 'Write ONE quip. Plain text, no quotes, no preamble, no markdown. Under 200 characters. Just the quip.');
  return lines.join('\n');
}
```

- [ ] **Step 4: Run tests and build**

Run: `npx vitest run tests/unit/quipGenerator.test.ts` → all pass.
Run: `npm run build` → exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/services/quipGenerator.ts tests/unit/quipGenerator.test.ts
git commit -m "feat(quips): enrich prompt with persona, count, progression, memes, history"
```

---

### Task 6: Search grounding on all three providers

**Files:**
- Modify: `src/services/quipGenerator.ts`
- Test: `tests/unit/quipGenerator.test.ts`

**Interfaces:**
- Produces: internal only. Request bodies gain search tools; `OPENAI_MODEL` becomes `gpt-4o-mini-search-preview`; `REQUEST_TIMEOUT_MS` becomes `8_000`; all providers use `maxTokens`/`max_tokens` of 300 (search-grounded responses are longer before `normalizeQuip` trims them; the 280-char guard still applies after cleanup).

- [ ] **Step 1: Write the failing tests**

```typescript
it('grounds Gemini with the google_search tool', async () => {
  setAllKeys();
  const fetchMock = mockAllProvidersOk();
  await generateSignupQuip({ raidDay: 'Sunday', twoDayReminder: false, now: GEMINI_FIRST });
  const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
  expect(body.tools).toEqual([{ google_search: {} }]);
});

it('grounds OpenAI with the search-preview model and web_search_options', async () => {
  setAllKeys();
  const fetchMock = mockAllProvidersOk();
  await generateSignupQuip({ raidDay: 'Sunday', twoDayReminder: false, now: OPENAI_FIRST });
  const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
  expect(body.model).toBe('gpt-4o-mini-search-preview');
  expect(body.web_search_options).toEqual({ search_context_size: 'low' });
  expect(body.temperature).toBeUndefined();
});

it('grounds Claude with the web_search server tool capped at one search', async () => {
  setAllKeys();
  const fetchMock = mockAllProvidersOk();
  await generateSignupQuip({ raidDay: 'Sunday', twoDayReminder: false, now: CLAUDE_FIRST });
  const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
  expect(body.tools).toEqual([{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }]);
});

it('ignores non-text blocks (search results, citations) in the Claude response', async () => {
  setAllKeys();
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      content: [
        { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'trending meme' } },
        { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [] },
        { type: 'text', text: 'Grounded quip!' },
      ],
    }),
    text: async () => '',
  })) as unknown as typeof fetch;

  const result = await generateSignupQuip({ raidDay: 'Sunday', twoDayReminder: false, now: CLAUDE_FIRST });
  expect(result.quip).toBe('Grounded quip!');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/quipGenerator.test.ts`
Expected: the three grounding tests FAIL (no `tools`/`web_search_options` in bodies, old model name). The Claude non-text-block test should already PASS (the existing filter handles it) — keep it as a regression guard.

- [ ] **Step 3: Implement**

In `src/services/quipGenerator.ts`:

```typescript
// 8s (up from 5s): all three providers now carry a server-side web-search
// tool for meme grounding, and a search round-trip eats most of a 5s budget.
const REQUEST_TIMEOUT_MS = 8_000;
```

```typescript
// The search-preview variant is the only gpt-4o-mini that supports
// web_search_options on chat completions. It also rejects sampling params,
// which is why callOpenAI sends no temperature.
const OPENAI_MODEL = 'gpt-4o-mini-search-preview';
```

`callGemini` body:

```typescript
body: JSON.stringify({
  contents: [{ role: 'user', parts: [{ text: prompt }] }],
  tools: [{ google_search: {} }],
  generationConfig: { temperature: 0.9, topP: 0.95, maxOutputTokens: 300 },
}),
```

`callOpenAI` body (note: `temperature` removed — search-preview models reject it):

```typescript
body: JSON.stringify({
  model: OPENAI_MODEL,
  messages: [{ role: 'user', content: prompt }],
  max_tokens: 300,
  web_search_options: { search_context_size: 'low' },
}),
```

`callClaude` body:

```typescript
body: JSON.stringify({
  model: ANTHROPIC_MODEL,
  max_tokens: 300,
  messages: [{ role: 'user', content: prompt }],
  tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
}),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/quipGenerator.test.ts`
Expected: all pass.

- [ ] **Step 5: Live smoke test (manual, uses real keys from `.env`)**

Create `C:\Users\Ryan\AppData\Local\Temp\claude\G--repos-SeriouslyCasualBotV2\44621616-3d9d-494c-8944-ecc183b489cd\scratchpad\smoke-quip.mjs`:

```javascript
// Run from the repo root AFTER `npm run build`:
//   node --env-file=.env "<scratchpad>\smoke-quip.mjs"
const { generateSignupQuip } = await import(
  'file:///G:/repos/SeriouslyCasualBotV2/dist/services/quipGenerator.js'
);
for (const day of ['2026-01-03', '2026-01-04', '2026-01-05']) {
  const result = await generateSignupQuip({
    raidDay: 'Sunday',
    twoDayReminder: false,
    unsignedCount: 5,
    now: new Date(`${day}T12:00:00Z`),
  });
  console.log(day, JSON.stringify(result));
}
```

Expected: three lines, each `{"quip":"...","generated":true}` — one per provider — and no timeouts. If a provider's search grounding is rejected (HTTP 400), that provider's real error message appears in the warn log; stop and re-check that provider's request shape before continuing.

- [ ] **Step 6: Commit**

```bash
git add src/services/quipGenerator.ts tests/unit/quipGenerator.test.ts
git commit -m "feat(quips): ground all three providers with server-side web search"
```

---

### Task 7: `quip_history` table + helpers

**Files:**
- Modify: `src/database/schema.ts` (add table to `createTables` for fresh DBs)
- Modify: `src/database/db.ts` (migration v7 for existing DBs)
- Create: `src/functions/raids/quipHistory.ts`
- Test: `tests/unit/quipHistory.test.ts`

**Interfaces:**
- Consumes: `Database` type from `better-sqlite3`.
- Produces:

```typescript
export function getRecentQuips(db: Database.Database, limit?: number): string[]; // newest first, default 10
export function recordQuip(db: Database.Database, quip: string, keep?: number): void; // insert + trim, default keep 50
```

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/quipHistory.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createTables } from '../../src/database/schema.js';
import { runMigrations } from '../../src/database/db.js';
import { getRecentQuips, recordQuip } from '../../src/functions/raids/quipHistory.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  createTables(db);
  runMigrations(db);
});

afterEach(() => {
  db.close();
});

describe('quip history', () => {
  it('migration creates the quip_history table', () => {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'quip_history'")
      .get();
    expect(row).toBeDefined();
  });

  it('returns recent quips newest first, capped at the limit', () => {
    for (let i = 1; i <= 12; i++) recordQuip(db, `quip ${i}`);
    const recent = getRecentQuips(db, 10);
    expect(recent).toHaveLength(10);
    expect(recent[0]).toBe('quip 12');
    expect(recent[9]).toBe('quip 3');
  });

  it('returns an empty array when there is no history', () => {
    expect(getRecentQuips(db)).toEqual([]);
  });

  it('trims the table to the keep limit on insert', () => {
    for (let i = 1; i <= 55; i++) recordQuip(db, `quip ${i}`);
    const count = db.prepare('SELECT COUNT(*) AS n FROM quip_history').get() as { n: number };
    expect(count.n).toBe(50);
    // Oldest survivor is quip 6; quips 1-5 were trimmed.
    expect(getRecentQuips(db, 50).at(-1)).toBe('quip 6');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/quipHistory.test.ts`
Expected: FAIL — `quipHistory.ts` does not exist and the table is missing.

- [ ] **Step 3: Add the table to `createTables` and migration v7**

In `src/database/schema.ts`, append inside the `createTables` SQL block (same style as the other tables):

```sql
CREATE TABLE IF NOT EXISTS quip_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quip TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

In `src/database/db.ts`, append inside `runMigrations` after the `currentVersion < 6` block:

```typescript
if (currentVersion < 7) {
  // Anti-repetition memory for signup quips: recent generated quips are fed
  // back into the LLM prompt as "don't resemble these". Fresh DBs get the
  // table from createTables; IF NOT EXISTS keeps this idempotent there.
  database.transaction(() => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS quip_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        quip TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    database.prepare('INSERT INTO schema_version (version) VALUES (?)').run(7);
  })();
}
```

- [ ] **Step 4: Implement `src/functions/raids/quipHistory.ts`**

```typescript
import type Database from 'better-sqlite3';

/** Newest-first list of recent quips for the anti-repetition prompt block. */
export function getRecentQuips(db: Database.Database, limit = 10): string[] {
  const rows = db
    .prepare('SELECT quip FROM quip_history ORDER BY id DESC LIMIT ?')
    .all(limit) as { quip: string }[];
  return rows.map((r) => r.quip);
}

/**
 * Record a generated quip and trim the table to the newest `keep` rows.
 * Only LLM-generated quips should be recorded — the static fallback corpus
 * is meant to repeat.
 */
export function recordQuip(db: Database.Database, quip: string, keep = 50): void {
  db.prepare('INSERT INTO quip_history (quip) VALUES (?)').run(quip);
  db.prepare(
    'DELETE FROM quip_history WHERE id NOT IN (SELECT id FROM quip_history ORDER BY id DESC LIMIT ?)',
  ).run(keep);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/unit/quipHistory.test.ts`
Expected: all 4 pass. Also run `npx vitest run tests/unit` to confirm no other DB test regressed on the new migration.

- [ ] **Step 6: Commit**

```bash
git add src/database/schema.ts src/database/db.ts src/functions/raids/quipHistory.ts tests/unit/quipHistory.test.ts
git commit -m "feat(quips): add quip_history table and helpers (migration v7)"
```

---

### Task 8: Wire everything into `alertSignups`

**Files:**
- Modify: `src/functions/raids/alertSignups.ts`

**Interfaces:**
- Consumes: `getProgressionContext()` (Task 4), `getRecentQuips`/`recordQuip` (Task 7), `generateSignupQuip` returning `QuipResult` (Task 1) with the enriched options (Task 5).
- Produces: no new exports; behaviour change only.

No new unit tests — `alertSignups` has no existing test harness (it needs a Discord client mock), and every piece it composes is unit-tested in Tasks 1–7. Verification is `npm run build` + the existing suite.

- [ ] **Step 1: Add imports**

```typescript
import { getProgressionContext } from '../../services/quipContext.js';
import { getRecentQuips, recordQuip } from './quipHistory.js';
```

- [ ] **Step 2: Gather context and generate**

Replace the quip-generation block (currently `const overlordNames = ...` through the `generateSignupQuip` call, ~lines 120–128) with:

```typescript
// Generate a fresh signup quip via the rotating LLM cascade, with raid
// progression + recent-quip context. Progression is best-effort (null on
// any raider.io hiccup) and never blocks the alert.
const overlordNames = getOverlords().map((o) => o.name);
const progression = await getProgressionContext();
const recentQuips = getRecentQuips(db);

const { quip, generated } = await generateSignupQuip({
  raidDay: dayConfig.raidDay,
  twoDayReminder: dayConfig.twoDayReminder,
  overlordNames,
  unsignedCount: unsignedCharacters.length,
  progression,
  recentQuips,
});
```

- [ ] **Step 3: Use the quip and record it after a successful post**

Change the `content` template to use `quip` instead of `randomMessage` (if not already done in Task 1), and extend the final send block:

```typescript
try {
  await channel.send(content);
  // Only remember LLM-generated quips — the static corpus is meant to repeat.
  if (generated) {
    recordQuip(db, quip);
  }
  logger.info(
    'AlertSignups',
    `Sent signup alert for ${dayConfig.raidDay} (${unsignedCharacters.length} unsigned)`,
  );
} catch (error) {
  logger.error('AlertSignups', 'Failed to send signup alert', error as Error);
}
```

- [ ] **Step 4: Build and run the full unit suite**

Run: `npm run build` → exits 0.
Run: `npx vitest run tests/unit` → all pass.

- [ ] **Step 5: Commit**

```bash
git add src/functions/raids/alertSignups.ts
git commit -m "feat(quips): wire progression, unsigned count, and history into signup alerts"
```

---

### Task 9: Final verification

- [ ] **Step 1: Full build + unit suite from clean state**

Run: `npm run build && npx vitest run tests/unit`
Expected: build exits 0; all unit tests pass. (The `tests/e2e` suites fail at collection without a live Discord environment — that is pre-existing and out of scope; scope the vitest run to `tests/unit`.)

- [ ] **Step 2: Re-run the Task 6 live smoke test**

Run the scratchpad `smoke-quip.mjs` once more against the final build. Expected: three generated quips (one per provider), each logged at `info` with its resolved model name.

- [ ] **Step 3: Review the working tree**

Run: `git status` → clean except possibly the scratchpad (outside the repo). Run: `git log --oneline develop` → the task commits are present. **Do not push** — the user pushes when ready (develop auto-deploys the test bot).

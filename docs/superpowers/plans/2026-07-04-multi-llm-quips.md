# Multi-LLM Signup Quip Generation + Overlord Names — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend signup-quip generation from a single LLM (Gemini) to a Gemini → OpenAI → Claude → static-corpus cascade, and source leader names in the prompt from the `overlords` table instead of the hardcoded Warzania/Bing/Splo trio.

**Architecture:** `quipGenerator.ts` gains a provider array; `generateSignupQuip` iterates it, skipping providers with no API key and falling through on error/timeout/malformed output, then returns a static quip if all fail. Each provider is a raw-`fetch` transport reusing one shared timeout helper, one `buildPrompt`, and one `normalizeQuip`/length guard. Overlord names are resolved by `alertSignups` (which has DB access) and passed in, keeping `quipGenerator` DB-free.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node `fetch` + `AbortController`, Vitest, better-sqlite3 (via existing `overlords.ts`).

## Global Constraints

- No new npm dependencies — all three providers use raw `fetch` (matches existing Gemini code).
- Request timeout is the existing `REQUEST_TIMEOUT_MS` (5000 ms) for every provider.
- API keys travel in headers, never query params.
- Quips are capped at `MAX_QUIP_LENGTH` (280); over-length output is treated as a format failure and rejected.
- Models (cheapest tier each): Gemini `gemini-2.0-flash` (existing), OpenAI `gpt-4o-mini`, Claude `claude-haiku-4-5`.
- Claude call uses a plain Messages request (`max_tokens: 120`, no `thinking`/`effort` — `effort` errors on Haiku 4.5); Anthropic header `anthropic-version: 2023-06-01`.
- `generateSignupQuip` must never throw — it always returns a postable string.
- Test-run command: `npx vitest run tests/unit/quipGenerator.test.ts`. Typecheck: `npx tsc --noEmit`.

---

### Task 1: Add OpenAI + Anthropic API-key config

**Files:**
- Modify: `src/config.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: existing `config` object with the `geminiApiKey` lazy getter.
- Produces: `config.openaiApiKey: string` and `config.anthropicApiKey: string` — lazy getters returning `''` when the env var is unset.

- [ ] **Step 1: Add the two getters to `src/config.ts`**

Add immediately after the existing `geminiApiKey` getter (currently at lines 27–29):

```ts
  // Optional: second/third quip-generator providers, tried after Gemini.
  // Read lazily so tests that toggle the env var between cases see the change.
  get openaiApiKey() {
    return process.env.OPENAI_API_KEY ?? '';
  },
  get anthropicApiKey() {
    return process.env.ANTHROPIC_API_KEY ?? '';
  },
```

- [ ] **Step 2: Document the new vars in `.env.example`**

Find the existing `GEMINI_API_KEY` line and add below it:

```
# Optional: additional quip-generator fallbacks, tried in order after Gemini.
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: exits 0 (no type errors).

- [ ] **Step 4: Commit**

```bash
git add src/config.ts .env.example
git commit -m "feat(config): add optional OpenAI and Anthropic API keys"
```

---

### Task 2: Use Overlord names in the prompt (optional field)

**Files:**
- Modify: `src/services/quipGenerator.ts`
- Test: `tests/unit/quipGenerator.test.ts`

**Interfaces:**
- Consumes: existing `buildPrompt(options)` and exported `GenerateQuipOptions`.
- Produces: `GenerateQuipOptions` gains `overlordNames?: string[]`. When present and non-empty, the prompt's tone line references those Overlords; when empty/absent, no leader-name clause appears.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/quipGenerator.test.ts` (inside the `describe` block). These capture the outgoing prompt from the mocked `fetch` body:

```ts
  it('includes Overlord names in the prompt when provided', async () => {
    process.env.GEMINI_API_KEY = 'test-key';

    let capturedBody = '';
    globalThis.fetch = vi.fn(async (_url: string, init: RequestInit) => {
      capturedBody = String(init.body);
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: 'Sign up!' }] } }],
        }),
        text: async () => '',
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await generateSignupQuip({
      raidDay: 'Wednesday',
      twoDayReminder: false,
      overlordNames: ['Gandalf', 'Saruman'],
    });

    expect(capturedBody).toContain('Gandalf, Saruman');
    expect(capturedBody).toContain('Overlords');
  });

  it('omits the leader-name clause when no Overlords are provided', async () => {
    process.env.GEMINI_API_KEY = 'test-key';

    let capturedBody = '';
    globalThis.fetch = vi.fn(async (_url: string, init: RequestInit) => {
      capturedBody = String(init.body);
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: 'Sign up!' }] } }],
        }),
        text: async () => '',
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await generateSignupQuip({ raidDay: 'Wednesday', twoDayReminder: false });

    expect(capturedBody).not.toContain('Overlords');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/quipGenerator.test.ts`
Expected: the two new tests FAIL (`capturedBody` contains the old hardcoded `guild leaders (Warzania, Bing, Splo)` line, so `Overlords` assertion fails).

- [ ] **Step 3: Add `overlordNames` to `GenerateQuipOptions`**

In `src/services/quipGenerator.ts`, change the interface (currently lines 34–37):

```ts
export interface GenerateQuipOptions {
  raidDay: string;
  twoDayReminder: boolean;
  /** Names of the guild's Overlords to optionally reference. Empty = no name reference. */
  overlordNames?: string[];
}
```

- [ ] **Step 4: Rewrite the tone line in `buildPrompt`**

Replace the current `buildPrompt` body (lines 70–88) so the tone line is conditional:

```ts
function buildPrompt({ raidDay, twoDayReminder, overlordNames = [] }: GenerateQuipOptions): string {
  const examples = V1_SAMPLE_QUIPS.map((q, i) => `${i + 1}. ${q}`).join('\n');
  const reminderNote = twoDayReminder
    ? 'This is the 48-hour early reminder, so a nudge-not-yell tone.'
    : 'This is the day-of reminder, so urgency is fair game.';

  const toneLine =
    overlordNames.length > 0
      ? `Tone: playful, sarcastic, WoW-themed. Occasionally reference the guild's Overlords (${overlordNames.join(', ')}). OK to be cheeky; keep it safe for a shared Discord channel.`
      : 'Tone: playful, sarcastic, WoW-themed. OK to be cheeky; keep it safe for a shared Discord channel.';

  return [
    'You write one-line nudges that a World of Warcraft raiding guild uses to get their raiders to sign up for the next raid.',
    '',
    `Context: the next raid is on ${raidDay}. ${reminderNote}`,
    '',
    toneLine,
    '',
    'Examples of the tone:',
    examples,
    '',
    'Write ONE quip. Plain text, no quotes, no preamble, no markdown. Under 200 characters. Just the quip.',
  ].join('\n');
}
```

Note: `V1_SAMPLE_QUIPS` (the few-shot examples / static fallback pool) still contains Warzania/Bing/Splo lines — that is historical tone corpus, not a leader-name *instruction*, and is intentionally left unchanged.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/unit/quipGenerator.test.ts`
Expected: all tests PASS (new prompt tests plus the existing suite).

- [ ] **Step 6: Commit**

```bash
git add src/services/quipGenerator.ts tests/unit/quipGenerator.test.ts
git commit -m "feat(quips): reference Overlord names in prompt instead of hardcoded trio"
```

---

### Task 3: Refactor into a provider cascade and add the OpenAI provider

**Files:**
- Modify: `src/services/quipGenerator.ts`
- Test: `tests/unit/quipGenerator.test.ts`

**Interfaces:**
- Consumes: `config.geminiApiKey`, `config.openaiApiKey`; existing `buildPrompt`, `normalizeQuip`, `MAX_QUIP_LENGTH`, `randomFallback`, `GEMINI_ENDPOINT`, `REQUEST_TIMEOUT_MS`, `GeminiResponse`.
- Produces: internal `fetchWithTimeout(url, init): Promise<Response>`; `callGemini(apiKey, prompt): Promise<string | null>`; `callOpenAI(apiKey, prompt): Promise<string | null>`; a `PROVIDERS` array; a rewritten `generateSignupQuip` that iterates providers. Return contract of `generateSignupQuip` is unchanged (`Promise<string>`, never throws).

- [ ] **Step 1: Write the failing test (Gemini fails → OpenAI used)**

Append to the `describe` block. Also extend the top-of-file env save/restore for the new keys:

At the top of the file, after line 5 (`const originalApiKey = ...`), add:

```ts
const originalOpenAIKey = process.env.OPENAI_API_KEY;
const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
```

In `afterEach` (after the existing GEMINI restore, before `vi.restoreAllMocks()`), add:

```ts
  if (originalOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenAIKey;
  if (originalAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
```

Then add the test:

```ts
  it('uses OpenAI when Gemini fails', async () => {
    process.env.GEMINI_API_KEY = 'gemini-key';
    process.env.OPENAI_API_KEY = 'openai-key';
    delete process.env.ANTHROPIC_API_KEY;

    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes('generativelanguage.googleapis.com')) {
        return { ok: false, status: 500, json: async () => ({}), text: async () => 'boom' } as unknown as Response;
      }
      if (url.includes('api.openai.com')) {
        return {
          ok: true,
          json: async () => ({ choices: [{ message: { content: 'OpenAI says sign up!' } }] }),
          text: async () => '',
        } as unknown as Response;
      }
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;

    const quip = await generateSignupQuip({ raidDay: 'Wednesday', twoDayReminder: false });
    expect(quip).toBe('OpenAI says sign up!');
  });

  it('skips OpenAI when its key is unset and falls back to static', async () => {
    process.env.GEMINI_API_KEY = 'gemini-key';
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes('api.openai.com')) throw new Error('OpenAI should not be called');
      return { ok: false, status: 500, json: async () => ({}), text: async () => 'boom' } as unknown as Response;
    }) as unknown as typeof fetch;

    const quip = await generateSignupQuip({ raidDay: 'Wednesday', twoDayReminder: false });
    expect(typeof quip).toBe('string');
    expect(quip.length).toBeGreaterThan(0);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/quipGenerator.test.ts`
Expected: `uses OpenAI when Gemini fails` FAILS (OpenAI not yet a provider — Gemini failure goes straight to static fallback, so the returned quip is a V1 corpus line, not `'OpenAI says sign up!'`).

- [ ] **Step 3: Add the shared timeout helper**

In `src/services/quipGenerator.ts`, add above `callGemini`:

```ts
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Rewrite `callGemini` to return raw text (no normalization here)**

Replace the existing `callGemini` (lines 98–155) with:

```ts
async function callGemini(apiKey: string, prompt: string): Promise<string | null> {
  // Send the key in the x-goog-api-key header rather than as a query param.
  const response = await fetchWithTimeout(GEMINI_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.9, topP: 0.95, maxOutputTokens: 120 },
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Gemini HTTP ${response.status}: ${body.slice(0, 200)}`);
  }

  const json = (await response.json()) as GeminiResponse;
  if (json.error?.message) {
    throw new Error(`Gemini API error: ${json.error.message}`);
  }

  const candidate = json.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const text = parts.map((p) => p.text ?? '').join('').trim();
  if (!text) {
    logger.warn('QuipGen', `Gemini returned no text (finishReason: ${candidate?.finishReason ?? 'unknown'})`);
    return null;
  }
  return text;
}
```

- [ ] **Step 5: Add the OpenAI provider**

Add after `callGemini`:

```ts
const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const OPENAI_MODEL = 'gpt-4o-mini';

interface OpenAIResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

async function callOpenAI(apiKey: string, prompt: string): Promise<string | null> {
  const response = await fetchWithTimeout(OPENAI_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 120,
      temperature: 0.9,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`OpenAI HTTP ${response.status}: ${body.slice(0, 200)}`);
  }

  const json = (await response.json()) as OpenAIResponse;
  if (json.error?.message) {
    throw new Error(`OpenAI API error: ${json.error.message}`);
  }

  const text = json.choices?.[0]?.message?.content?.trim() ?? '';
  if (!text) {
    logger.warn('QuipGen', 'OpenAI returned no text');
    return null;
  }
  return text;
}
```

- [ ] **Step 6: Add the provider type + array and rewrite `generateSignupQuip`**

Add the provider abstraction just above `generateSignupQuip`:

```ts
interface QuipProvider {
  name: string;
  getKey: () => string;
  call: (apiKey: string, prompt: string) => Promise<string | null>;
}

const PROVIDERS: QuipProvider[] = [
  { name: 'Gemini', getKey: () => config.geminiApiKey, call: callGemini },
  { name: 'OpenAI', getKey: () => config.openaiApiKey, call: callOpenAI },
];
```

Replace the existing `generateSignupQuip` body (lines 45–61) with:

```ts
export async function generateSignupQuip(options: GenerateQuipOptions): Promise<string> {
  const prompt = buildPrompt(options);

  for (const provider of PROVIDERS) {
    const apiKey = provider.getKey();
    if (!apiKey) continue;

    try {
      const raw = await provider.call(apiKey, prompt);
      if (!raw) continue;

      const cleaned = normalizeQuip(raw);
      if (cleaned.length === 0 || cleaned.length > MAX_QUIP_LENGTH) {
        logger.warn('QuipGen', `${provider.name} quip rejected (length ${cleaned.length}): ${cleaned.slice(0, 80)}`);
        continue;
      }

      logger.debug('QuipGen', `Quip generated via ${provider.name}`);
      return cleaned;
    } catch (err) {
      logger.warn(
        'QuipGen',
        `${provider.name} call failed, trying next provider: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return randomFallback();
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run tests/unit/quipGenerator.test.ts`
Expected: all tests PASS (existing Gemini + fallback tests, prompt tests, and the two new OpenAI tests).

- [ ] **Step 8: Typecheck**

Run: `npx tsc --noEmit`
Expected: exits 0.

- [ ] **Step 9: Commit**

```bash
git add src/services/quipGenerator.ts tests/unit/quipGenerator.test.ts
git commit -m "feat(quips): add OpenAI as second-tier provider in a cascade"
```

---

### Task 4: Add the Claude provider

**Files:**
- Modify: `src/services/quipGenerator.ts`
- Test: `tests/unit/quipGenerator.test.ts`

**Interfaces:**
- Consumes: `config.anthropicApiKey`, `fetchWithTimeout`, the `PROVIDERS` array.
- Produces: `callClaude(apiKey, prompt): Promise<string | null>`; a third `PROVIDERS` entry (`Claude`).

- [ ] **Step 1: Write the failing tests (Gemini+OpenAI fail → Claude; all fail → static)**

Append to the `describe` block:

```ts
  it('uses Claude when Gemini and OpenAI both fail', async () => {
    process.env.GEMINI_API_KEY = 'gemini-key';
    process.env.OPENAI_API_KEY = 'openai-key';
    process.env.ANTHROPIC_API_KEY = 'anthropic-key';

    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes('api.anthropic.com')) {
        return {
          ok: true,
          json: async () => ({ content: [{ type: 'text', text: 'Claude says sign up!' }] }),
          text: async () => '',
        } as unknown as Response;
      }
      // Gemini + OpenAI both error
      return { ok: false, status: 500, json: async () => ({}), text: async () => 'boom' } as unknown as Response;
    }) as unknown as typeof fetch;

    const quip = await generateSignupQuip({ raidDay: 'Sunday', twoDayReminder: true });
    expect(quip).toBe('Claude says sign up!');
  });

  it('falls back to a static quip when all three providers fail', async () => {
    process.env.GEMINI_API_KEY = 'gemini-key';
    process.env.OPENAI_API_KEY = 'openai-key';
    process.env.ANTHROPIC_API_KEY = 'anthropic-key';

    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => 'boom',
    })) as unknown as typeof fetch;

    const quip = await generateSignupQuip({ raidDay: 'Wednesday', twoDayReminder: false });
    expect(typeof quip).toBe('string');
    expect(quip.length).toBeGreaterThan(0);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/quipGenerator.test.ts`
Expected: `uses Claude when Gemini and OpenAI both fail` FAILS (Claude is not yet a provider, so it falls to a static quip instead of `'Claude says sign up!'`).

- [ ] **Step 3: Add the Claude provider**

In `src/services/quipGenerator.ts`, add after `callOpenAI`:

```ts
const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-haiku-4-5';
const ANTHROPIC_VERSION = '2023-06-01';

interface AnthropicResponse {
  content?: Array<{ type?: string; text?: string }>;
  error?: { message?: string };
}

async function callClaude(apiKey: string, prompt: string): Promise<string | null> {
  const response = await fetchWithTimeout(ANTHROPIC_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 120,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Anthropic HTTP ${response.status}: ${body.slice(0, 200)}`);
  }

  const json = (await response.json()) as AnthropicResponse;
  if (json.error?.message) {
    throw new Error(`Anthropic API error: ${json.error.message}`);
  }

  const text = (json.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
    .trim();
  if (!text) {
    logger.warn('QuipGen', 'Anthropic returned no text');
    return null;
  }
  return text;
}
```

- [ ] **Step 4: Register Claude in the `PROVIDERS` array**

Update `PROVIDERS` to include the third entry (order matters — Claude last):

```ts
const PROVIDERS: QuipProvider[] = [
  { name: 'Gemini', getKey: () => config.geminiApiKey, call: callGemini },
  { name: 'OpenAI', getKey: () => config.openaiApiKey, call: callOpenAI },
  { name: 'Claude', getKey: () => config.anthropicApiKey, call: callClaude },
];
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/unit/quipGenerator.test.ts`
Expected: all tests PASS.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/services/quipGenerator.ts tests/unit/quipGenerator.test.ts
git commit -m "feat(quips): add Claude (Haiku) as third-tier provider"
```

---

### Task 5: Pass Overlord names from `alertSignups`

**Files:**
- Modify: `src/functions/raids/alertSignups.ts`

**Interfaces:**
- Consumes: `getOverlords(): OverlordRow[]` from `./overlords.js`; `generateSignupQuip(options)` now accepting `overlordNames`.
- Produces: no new exports — `alertSignups` now resolves Overlord names and forwards them.

- [ ] **Step 1: Import `getOverlords`**

In `src/functions/raids/alertSignups.ts`, add to the imports (near the other `../` imports, e.g. after the `generateSignupQuip` import on line 7):

```ts
import { getOverlords } from './overlords.js';
```

- [ ] **Step 2: Resolve names and pass them into `generateSignupQuip`**

Replace the current call (lines 119–122):

```ts
  const randomMessage = await generateSignupQuip({
    raidDay: dayConfig.raidDay,
    twoDayReminder: dayConfig.twoDayReminder,
  });
```

with:

```ts
  const overlordNames = getOverlords().map((o) => o.name);

  const randomMessage = await generateSignupQuip({
    raidDay: dayConfig.raidDay,
    twoDayReminder: dayConfig.twoDayReminder,
    overlordNames,
  });
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: exits 0.

- [ ] **Step 4: Run the full unit suite**

Run: `npx vitest run`
Expected: all tests PASS (no regression in `alertSignups`-adjacent tests).

- [ ] **Step 5: Commit**

```bash
git add src/functions/raids/alertSignups.ts
git commit -m "feat(quips): feed Overlord names into signup quip prompt"
```

---

## Self-Review

**Spec coverage:**
- Provider cascade (Gemini → OpenAI → Claude → static) — Tasks 3 & 4. ✓
- Skip-on-missing-key, fall-through-on-error, never-throws — Task 3 Step 6 orchestrator. ✓
- Raw fetch + shared 5s timeout, no new deps — Task 3 Step 3 (`fetchWithTimeout`), used by all providers. ✓
- OpenAI `gpt-4o-mini` / `choices[0].message.content` — Task 3 Step 5. ✓
- Claude `claude-haiku-4-5`, `x-api-key` + `anthropic-version`, `content[0].text`, no thinking — Task 4 Step 3. ✓
- Config getters + `.env.example` — Task 1. ✓
- Overlord names via `alertSignups` → `overlordNames` on `GenerateQuipOptions`; empty → no name clause — Tasks 2 & 5. ✓
- Shared `buildPrompt`/`normalizeQuip`/length guard — reused, normalization centralized in orchestrator (Task 3 Step 6). ✓
- Per-provider warn logging + success debug line — Task 3 Step 6. ✓
- Tests for cascade paths + prompt name inclusion/omission — Tasks 2, 3, 4. ✓
- Out of scope (cron, unsigned logic, no selection UI, no SDK) — respected; no tasks touch them. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; commands have expected output. ✓

**Type consistency:** `QuipProvider` (`getKey`/`call`) consistent between Tasks 3 & 4; `callGemini`/`callOpenAI`/`callClaude` all `(apiKey, prompt) => Promise<string | null>`; `overlordNames?: string[]` defined in Task 2 and consumed in Task 5; `fetchWithTimeout` defined in Task 3, reused in Task 4. ✓

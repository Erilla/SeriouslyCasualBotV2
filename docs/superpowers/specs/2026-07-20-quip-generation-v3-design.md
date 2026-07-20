# Quip Generation v3 — Rotation, Context, Memes, Memory

**Date:** 2026-07-20
**Status:** Design approved, pending spec review
**Builds on:** `2026-07-04-multi-llm-quips-design.md` (three-provider cascade)

## Problem

Signup quips (`src/services/quipGenerator.ts`, called from
`src/functions/raids/alertSignups.ts`) work, but:

1. Gemini always goes first, so OpenAI/Claude only run on Gemini failure —
   the guild effectively hears one model's voice.
2. The bot log only says a quip was generated at `debug` level, without the model.
3. Quips are generic: no awareness of the guild's raid progression, the number
   of unsigned raiders, or anything topical; and the model converges on the
   same jokes because it has no memory of past quips.

## 1. Provider rotation

The starting provider rotates daily by **day-of-year mod 3** over
`[Gemini, OpenAI, Claude]`. Day-derived (not an in-memory counter) because the
bot restarts on every deploy, which would reset a counter to Gemini.

- Rotation reorders the cascade; it does not remove fallback. Day k tries
  `PROVIDERS[k%3]`, then `[(k+1)%3]`, then `[(k+2)%3]`, then the static corpus.
- Providers with unset keys are skipped, as today.
- The rotation function takes a `Date` parameter (defaulting to `new Date()`)
  so tests can pin the order.

## 2. Logging the model used

- Each provider entry gains a `model` field (`gemini-flash-lite-latest`,
  `gpt-4o-mini-search-preview`, `claude-haiku-4-5`).
- Success log is promoted from `debug` to `info` and includes the **resolved**
  model where the API echoes it (Gemini returns `modelVersion`, OpenAI and
  Anthropic echo `model`), falling back to the requested name:
  `Quip generated via Gemini (gemini-3.1-flash-lite)`.
- Static-corpus fallback also logs at `info`: `Quip fallback: static V1 corpus`.
- Per-provider failure stays `warn`, as today.

## 3. Progression context (raider.io)

New helper `getProgressionContext()` in `src/services/quipContext.ts`
(new module so `quipGenerator` stays fetch-mock testable and DB/API-free):

- Find the current raid the way `checkRaidExpansions` does: walk
  `getRaidStaticData(expansionId)` from a floor expansion upward, pick the raid
  whose `ends.eu` is null or in the future, skipping Fated/Awakened.
- Call `getRaidRankings(raid.slug)`; derive `killed` via the same
  array-or-number guard used in `updateAchievements`.
- Result (`ProgressionContext | null`):
  - `killed < total` → `{ mode: 'progress', bossName: encounters[killed].name, killed, total, raidName }`
    (static-data `encounters` are in kill order).
  - `killed === total` → `{ mode: 'reclear', endBossName: encounters[total-1].name, raidName }`.
  - Any API error, no rankings (fresh tier), or no current raid → `null`, logged
    at `debug`. **The quip never fails or blocks on raider.io.**
- Called once per alert by `alertSignups` and passed in via options — a
  handful of raider.io calls (~4-5: the expansion walk plus rankings) per
  alert, 4 alerts/week — negligible.

## 4. Prompt enrichment

`GenerateQuipOptions` gains:

```ts
unsignedCount: number;                    // from alertSignups (already computed)
progression?: ProgressionContext | null;  // from getProgressionContext()
recentQuips?: string[];                   // last 10 from quip_history
```

`buildPrompt` additions:

- **Persona:** picked at random per call from a hardcoded list of ~8
  (drill sergeant, disappointed parent, loot goblin, condescending gnome,
  doomsaying shadow priest, overly cheerful holy priest, guild bank goblin,
  melodramatic bard). One line: *"Write in the voice of a {persona}."*
- **Unsigned count:** *"{n} raiders still haven't signed up."*
- **Progression:** progress mode → *"The guild is currently progressing
  {bossName} in {raidName} ({killed}/{total}M)."*; reclear mode → *"The guild
  has {raidName} on farm — {endBossName} is dead, now it's reclear season."*
  Omitted when null.
- **Meme licence:** *"You may reference a classic WoW meme (Leeroy Jenkins,
  'more dots', 'You are not prepared', 'You face Jaina', etc.) or a currently
  trending internet meme — if you go trending, use web search to find one."*
- **Anti-repetition:** *"Recent quips — write something clearly different from
  all of these:"* followed by the last 10, when provided.
- **Restraint rule:** *"Use at most one or two of these flavour elements
  (persona is always on); don't cram everything into one line."*

## 5. Search grounding (all three providers)

Each provider call gains server-side web search, capped at **1 search**, so the
model can find a genuinely current meme. The model decides whether to search;
classic-meme quips stay zero-latency.

| Provider | Mechanism |
|---|---|
| Gemini | `tools: [{ google_search: {} }]` on generateContent |
| OpenAI | model becomes `gpt-4o-mini-search-preview` with `web_search_options: { search_context_size: 'low' }` (same chat-completions endpoint/response shape) |
| Claude | `tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }]` on the Messages request |

- **Timeout:** `REQUEST_TIMEOUT_MS` 5s → 8s (all calls; searches add latency).
- **Cost:** ≤ ~17 searches/month worst case ≈ pennies (Claude $10/1k,
  OpenAI ~$25/1k, Gemini free-tier grounding allowance).
- **Response parsing:** unchanged. Claude search/citation blocks are non-`text`
  types our filter already skips; OpenAI search-preview keeps
  `choices[0].message.content`; Gemini keeps `parts[].text`. `normalizeQuip`
  + the 280-char guard remain the format safety net.
- Citation note: quips are transformed one-liners in a private Discord, not
  displayed API output with sources; accepted as-is per user decision.

## 6. Anti-repetition memory

- New migration (next `schema_version`) creates:

  ```sql
  CREATE TABLE quip_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quip TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  ```

- So the caller can tell generated from fallback, `generateSignupQuip`'s
  return type changes from `string` to
  `{ quip: string; generated: boolean }` (callers and tests updated).
- `alertSignups` reads the newest 10 before generating (passes as
  `recentQuips`) and inserts the used quip after posting — **generated quips
  only** (`generated: true`), not static-corpus fallbacks (the corpus is
  meant to repeat).
- After insert, trim to the newest 50.
- Plain SQL via the existing `better-sqlite3` handle in `alertSignups`;
  `quipGenerator` stays DB-free.

## Testing

Extend `tests/unit/quipGenerator.test.ts` (+ new `quipContext.test.ts`):

- Rotation: pinned dates → expected provider order; fallback still walks the
  rotated order; unset-key providers skipped.
- Logging: success logs at `info` with resolved model name from the mocked
  response body; fallback logs at `info`.
- Prompt: contains persona line, unsigned count, progression line (both modes,
  omitted when null), meme licence, recent-quips block when provided.
- Grounding: Gemini body includes `google_search` tool; OpenAI body uses
  search-preview model + `web_search_options`; Claude body includes
  `web_search_20250305` with `max_uses: 1`.
- Claude parsing ignores non-text blocks mixed into `content`.
- `getProgressionContext`: progress mode, reclear mode, and null on API
  error / empty rankings (mocked raider.io).
- History: insert-after-post, trim-to-50, fallback quips not inserted
  (integration-style test against an in-memory DB, mirroring existing DB tests).

## Out of scope

- No change to cron schedule, unsigned-raider mention logic, or channel
  resolution.
- No settings/UI for personas, rotation, or history depth — all in code.
- No SDK adoption; raw `fetch` stays.
- No search grounding outside the quip path.

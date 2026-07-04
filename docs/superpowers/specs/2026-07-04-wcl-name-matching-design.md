# Spec: symmetric name matching for WCL trial-log lookup

**Date:** 2026-07-04
**Status:** Approved, ready for implementation plan

## Goal

Make WarcraftLogs trial-log attendance matching robust to **case and accent drift**
between a trial's stored `character_name` and the character name WCL stores, so that a
trial who actually raided is not silently reported as having no logs.

## Problem

`getTrialLogs` (`src/services/warcraftlogs.ts:98`) fetches the guild's recent WCL
attendance and keeps reports where some player was present under the trial's name. The
match is a strict, **case-sensitive** `===`:

```ts
player.name === characterName && player.presence === 1   // warcraftlogs.ts:126
```

`character_name` originates as officer free-text (the create/edit trial modal,
`src/interactions/trial.ts:98`) or is derived from a Raider.IO URL
(`deriveCharacterNameFromAnswers`), which preserves accents (e.g. `Lunéshadow`). WCL
stores the character's real name with exact accents and case (e.g. `Héphaestüs`). Any
divergence in case or accents makes an actually-present trial match nothing and report
**"No raid logs found"** — a silent false negative.

WoW character names are letters-only (accented Latin allowed on EU realms), so **case and
accents are the only realistic drift modes.** Punctuation/emoji stripping buys nothing
here and only adds collision risk, so it is deliberately excluded.

## Approach

Normalize **both** sides symmetrically before comparing, using a case-fold + accent-fold
(deburr). One-sided normalization would guarantee misses (folding the trial name to
`hephaestus` while comparing against WCL's `Héphaestüs`), so the fold is applied to both
`player.name` and `characterName`.

### The normalizer

A pure helper, co-located in `warcraftlogs.ts` and exported for testing:

```ts
/**
 * Normalize a character name for FUZZY attendance matching only:
 * accent-fold (NFD + strip diacritics) + lowercase + trim.
 * Do NOT use for identity keys or any exact-identity comparison
 * (raider_identity_map keys, ignored_characters, etc.).
 */
export function normalizeCharacterName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();
}
```

Examples: `Héphaestüs` → `hephaestus`, `SHADOWLEIF` → `shadowleif`.

**It lives in `warcraftlogs.ts`, not a shared `src/utils` module, by design.** A general
shared normalizer would invite reuse in exact-identity comparisons (identity-map keys,
ignored-character lookups), where accent/case-folding would be wrong. Keeping it local
bounds its blast radius to WCL fuzzy matching.

### Testable matching seam

Extract the pure matching logic (`filter → map → reverse`) out of `getTrialLogs` into an
exported function, so the whole matching path is unit-testable with zero HTTP/OAuth
mocking (which is why no test exists today):

```ts
export function extractMatchingCodes(
  reports: AttendanceReport[],
  characterName: string,
): string[] {
  const target = normalizeCharacterName(characterName);   // normalize target once
  return reports
    .filter((r) =>
      r.players.some(
        (p) => p.presence === 1 && normalizeCharacterName(p.name) === target,
      ),
    )
    .map((r) => r.code)
    .reverse(); // preserve V1 ordering — see existing comment at warcraftlogs.ts:131
}
```

`getTrialLogs` retains all HTTP, OAuth token caching, and fail-soft error handling, and
delegates the matching to `extractMatchingCodes`. The target name is normalized once
before the loop rather than per player.

## Components

- `normalizeCharacterName(name): string` — pure, exported, documented as matching-only.
- `extractMatchingCodes(reports, characterName): string[]` — pure, exported; contains the
  filter/map/reverse previously inlined in `getTrialLogs`.
- `getTrialLogs(characterName): Promise<string[]>` — unchanged responsibilities (OAuth,
  GraphQL fetch, fail-soft `catch`), now calling `extractMatchingCodes` for the match.

## Testing

New `tests/unit/warcraftlogs.test.ts` (pure functions, no HTTP):

- `normalizeCharacterName`:
  - accent-fold: `Héphaestüs` → `hephaestus`
  - case-fold: `SHADOWLEIF` → `shadowleif`
  - whitespace trim: `'  Thrall '` → `thrall`
  - idempotence: `f(f(x)) === f(x)`
- `extractMatchingCodes`:
  - accent-only mismatch now matches (`Hephaestus` finds `Héphaestüs`)
  - case-only mismatch now matches
  - `presence !== 1` (signed up, not present) is excluded
  - no match returns `[]`
  - result order is reversed relative to input (V1 ordering preserved)
  - multiple matching reports all returned

## Out of scope / unchanged

- Fail-soft behaviour on HTTP error / open circuit (returns `[]`).
- OAuth token caching.
- `generateTrialLogsContent` formatting (link list, "No raid logs found" copy).
- Any auto-match / `normalizeName` suggestion-matching work — deliberately separate; this
  helper must not leak into exact-identity comparisons.

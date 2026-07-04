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
accents are the only realistic drift modes.**

## Approach

Normalize **both** sides symmetrically before comparing. One-sided normalization would
guarantee misses (folding the trial name to `hephaestus` while comparing against WCL's
`Héphaestüs`), so the fold is applied to both `player.name` and `characterName`.

### Reuse the existing `normalizeName` helper

The auto-match work landed a name normalizer at `src/functions/raids/normalizeName.ts`
(commit `6afbc09`), documented as "normalise a name for fuzzy comparison between a WoW
character name and a Discord name, applied symmetrically to BOTH sides before an equality
check":

```ts
export function normalizeName(name: string): string {
  return name
    .split('-')[0]              // drop realm suffix (WoW names contain no '-')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')       // accent-fold: strip combining marks U+0300–U+036F
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ''); // strip spaces, punctuation, emoji
}
```

For letters-only WoW names this is **identical** to a case+accent-fold and strictly more
forgiving on edge cases (a stray realm suffix or accidental whitespace in officer input).
There is no input where a narrower deburr-only helper would match and `normalizeName`
would not. Adding a second near-identical normalizer would be needless duplication, so
WCL matching reuses `normalizeName`.

**Coupling note.** WCL auto-links reports with no human confirmation, whereas auto-match
*suggests* matches a human confirms. If `normalizeName` is later made more aggressive for
auto-match's benefit, it could silently change WCL matching. The `extractMatchingCodes`
tests (below) pin WCL's expected behaviour, so such drift trips a test.

**Layering note (follow-up, not this change).** `warcraftlogs.ts` is a `service` and
`normalizeName` lives under `functions/raids/`; a service importing from a feature module
mildly inverts the usual layering. Promoting `normalizeName` to a shared module is a
sensible follow-up, but is deferred: the auto-match session is concurrently modifying
files in `functions/raids/`, and moving the file now would risk conflicts. For this change
we import it in place.

### Testable matching seam

Extract the pure matching logic (`filter → map → reverse`) out of `getTrialLogs` into an
exported function, so the whole matching path is unit-testable with zero HTTP/OAuth
mocking (which is why no test exists today):

```ts
export function extractMatchingCodes(
  reports: AttendanceReport[],
  characterName: string,
): string[] {
  const target = normalizeName(characterName);   // normalize target once
  return reports
    .filter((r) =>
      r.players.some(
        (p) => p.presence === 1 && normalizeName(p.name) === target,
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

- `extractMatchingCodes(reports, characterName): string[]` — pure, exported from
  `warcraftlogs.ts`; contains the filter/map/reverse previously inlined in `getTrialLogs`;
  normalizes both sides via the reused `normalizeName`.
- `getTrialLogs(characterName): Promise<string[]>` — unchanged responsibilities (OAuth,
  GraphQL fetch, fail-soft `catch`), now calling `extractMatchingCodes` for the match.
- `normalizeName` — reused as-is from `src/functions/raids/normalizeName.ts`; **not**
  modified.

## Testing

New `tests/unit/warcraftlogs.test.ts` (pure functions, no HTTP), covering
`extractMatchingCodes`:

- accent-only mismatch now matches (`Hephaestus` finds `Héphaestüs`)
- case-only mismatch now matches (`SHADOWLEIF` finds `Shadowleif`)
- `presence !== 1` (signed up, not present) is excluded
- no match returns `[]`
- result order is reversed relative to input (V1 ordering preserved)
- multiple matching reports all returned

These cases also serve as the behavioural guard described in the coupling note: they pin
the case/accent semantics WCL relies on, independent of `normalizeName`'s internals.

## Out of scope / unchanged

- Fail-soft behaviour on HTTP error / open circuit (returns `[]`).
- OAuth token caching.
- `generateTrialLogsContent` formatting (link list, "No raid logs found" copy).
- `normalizeName` itself — reused, not modified.
- Any auto-match / suggestion-matching work — separate; this change only adds a *consumer*
  of `normalizeName`, it does not touch auto-match code.

# WCL Trial-Log Name Matching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make WarcraftLogs trial-log attendance matching case- and accent-insensitive so trials who actually raided aren't silently reported as having no logs.

**Architecture:** Reuse the existing `normalizeName` helper (`src/functions/raids/normalizeName.ts`, accent-fold + lowercase + realm-suffix drop + non-alphanumeric strip) — for letters-only WoW names it is identical to a case+accent fold. Extract the report filter/map/reverse out of `getTrialLogs` into a pure, exported `extractMatchingCodes` that normalizes both sides via `normalizeName`. `getTrialLogs` keeps OAuth/HTTP/fail-soft and delegates matching. The matching logic is unit-tested without HTTP.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest, Node 16+.

## Global Constraints

- ESM imports use `.js` specifiers (e.g. `../functions/raids/normalizeName.js`), per repo convention.
- Reuse `normalizeName` from `src/functions/raids/normalizeName.ts` — do **not** create a second normalizer, and do **not** modify `normalizeName.ts` (the auto-match session is concurrently editing files under `functions/raids/`).
- Preserve existing `.reverse()` ordering behaviour (V1 compatibility — see comment at `src/services/warcraftlogs.ts:131`).
- Do not change fail-soft behaviour, OAuth caching, or `generateTrialLogsContent` formatting.
- Test command: `npm test` (`vitest run --project default`). Run a single file with `npx vitest run --project default tests/unit/warcraftlogs.test.ts`.

---

### Task 1: Symmetric name matching in `warcraftlogs.ts`

**Files:**
- Modify: `src/services/warcraftlogs.ts` (export `AttendanceReport`; add exported `extractMatchingCodes`; import `normalizeName`; rewire `getTrialLogs` body at `warcraftlogs.ts:120-136`)
- Test: `tests/unit/warcraftlogs.test.ts` (create)
- Reference only (do not modify): `src/functions/raids/normalizeName.ts` — exports `normalizeName(name: string): string`.

**Interfaces:**
- Consumes:
  - `normalizeName(name: string): string` from `src/functions/raids/normalizeName.js` — folds accents + lowercases + drops realm suffix + strips non-alphanumerics.
  - the existing module-private `AttendanceReport` interface (`warcraftlogs.ts:58-61`: `{ code: string; players: { name: string; presence: number; type: string }[] }`). It must be exported so the test can construct fixtures.
- Produces:
  - `extractMatchingCodes(reports: AttendanceReport[], characterName: string): string[]` — report codes where a player with `presence === 1` matches `characterName` after normalizing both sides with `normalizeName`; order reversed relative to input.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/warcraftlogs.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  extractMatchingCodes,
  type AttendanceReport,
} from '../../src/services/warcraftlogs.js';

describe('extractMatchingCodes', () => {
  const report = (code: string, players: Array<[string, number]>): AttendanceReport => ({
    code,
    players: players.map(([name, presence]) => ({ name, presence, type: 'DPS' })),
  });

  it('matches despite an accent-only difference', () => {
    const reports = [report('AAA', [['Héphaestüs', 1]])];
    expect(extractMatchingCodes(reports, 'Hephaestus')).toEqual(['AAA']);
  });

  it('matches despite a case-only difference', () => {
    const reports = [report('AAA', [['Shadowleif', 1]])];
    expect(extractMatchingCodes(reports, 'SHADOWLEIF')).toEqual(['AAA']);
  });

  it('excludes players who signed up but were not present (presence !== 1)', () => {
    const reports = [report('AAA', [['Thrall', 0]])];
    expect(extractMatchingCodes(reports, 'Thrall')).toEqual([]);
  });

  it('returns [] when no player matches', () => {
    const reports = [report('AAA', [['Jaina', 1]])];
    expect(extractMatchingCodes(reports, 'Thrall')).toEqual([]);
  });

  it('returns all matching report codes in reversed input order', () => {
    const reports = [
      report('FIRST', [['Thrall', 1]]),
      report('SECOND', [['Jaina', 1]]),
      report('THIRD', [['thrall', 1]]),
    ];
    expect(extractMatchingCodes(reports, 'Thrall')).toEqual(['THIRD', 'FIRST']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project default tests/unit/warcraftlogs.test.ts`
Expected: FAIL — `extractMatchingCodes` is not exported (or `AttendanceReport` is not exported).

- [ ] **Step 3: Export the interface, import `normalizeName`, add `extractMatchingCodes`**

In `src/services/warcraftlogs.ts`:

1. Add the import near the top (after the existing imports, `warcraftlogs.ts:1-3`):

```ts
import { normalizeName } from '../functions/raids/normalizeName.js';
```

2. Change the `AttendanceReport` interface declaration (`warcraftlogs.ts:58`) from `interface AttendanceReport {` to `export interface AttendanceReport {`.

3. Add, immediately above `getTrialLogs` (before `warcraftlogs.ts:98`):

```ts
/**
 * From WCL attendance reports, return the codes of reports where a player
 * matching `characterName` (case- and accent-insensitive, via the shared
 * normalizeName) was present (`presence === 1`). Order is reversed relative to
 * input to preserve V1 ordering (see note in getTrialLogs).
 */
export function extractMatchingCodes(
  reports: AttendanceReport[],
  characterName: string,
): string[] {
  const target = normalizeName(characterName);
  return reports
    .filter((report) =>
      report.players.some(
        (player) =>
          player.presence === 1 && normalizeName(player.name) === target,
      ),
    )
    .map((report) => report.code)
    .reverse();
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project default tests/unit/warcraftlogs.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Rewire `getTrialLogs` to use `extractMatchingCodes`**

In `src/services/warcraftlogs.ts`, replace the body from `const reports = ...` through `return matchingCodes.reverse();` (currently `warcraftlogs.ts:120-136`) with:

```ts
    const reports = result.data.guildData.guild.attendance.data;

    // Match case- and accent-insensitively on both sides; extractMatchingCodes
    // preserves V1 ordering by reversing (consumers number output "1. Report ...";
    // WCL's natural attendance order isn't contractually documented, and .reverse()
    // has been in place since V1 — flipping it would silently change what reviewers see).
    return extractMatchingCodes(reports, characterName);
```

- [ ] **Step 6: Typecheck and run the full test suite**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all tests pass (new `warcraftlogs.test.ts` plus existing `updateTrialLogs.test.ts` still green).

- [ ] **Step 7: Commit**

```bash
git add src/services/warcraftlogs.ts tests/unit/warcraftlogs.test.ts
git commit -m "fix(trials): match WCL attendance case- and accent-insensitively"
```

---

## Self-Review

**1. Spec coverage:**
- Symmetric case+accent normalization → Step 3 reuses `normalizeName`, applied to both sides in `extractMatchingCodes`. ✓
- Reuse `normalizeName` rather than a new helper → Step 3 import + Global Constraints. ✓
- Do not modify `normalizeName.ts` → Global Constraints; Task touches only `warcraftlogs.ts` + test. ✓
- Testable seam via `extractMatchingCodes` extraction → Steps 3 & 5. ✓
- Normalize target once before loop → Step 3 (`const target` outside `.filter`). ✓
- Preserve `.reverse()` V1 ordering → Step 3 `.reverse()` + Step 5 comment; test asserts reversed order. ✓
- Tests pin WCL semantics (coupling guard) → Step 1 accent/case/presence/ordering cases. ✓
- Fail-soft / OAuth / formatting unchanged → only lines 120-136 + one import + one `export` keyword touched; `catch` block untouched. ✓

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to". All code shown in full. ✓

**3. Type consistency:** `extractMatchingCodes(reports: AttendanceReport[], characterName: string): string[]` used identically in the test import (Step 1), definition (Step 3), and call site (Step 5). `AttendanceReport` exported in Step 3 and imported as a type in Step 1. `normalizeName(name: string): string` matches its source signature. ✓

# Blizzard Realm Slug Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Use Blizzard-compatible realm URL slugs for equipment-profile requests so valid raiders do not receive false `Needs verification` exceptions.

**Architecture:** Keep request construction in `src/services/blizzard.ts`. Add a focused pure realm-normalization helper used only by the equipment URL builder; no database or caller changes are needed because the existing roster stores Raider.IO display realms. Extend the service request test to prove a spaced realm produces a hyphenated Blizzard path.

**Tech Stack:** TypeScript, Vitest, existing `httpRequest` wrapper.

## Global Constraints

- Normalize realms by trimming, lowercasing, and converting internal whitespace runs to `-` before `encodeURIComponent`.
- Preserve existing hyphens and character-name lowercasing/encoding.
- Do not change the circuit-breaker behavior or report presentation in this branch.
- Use test-first development: run the new assertion red before production code changes.

---

### Task 1: Normalize Blizzard equipment realm paths

**Files:**
- Modify: `src/services/blizzard.ts:54-65`
- Modify: `tests/unit/blizzard.test.ts:49-74`

**Interfaces:**
- Produces: `normalizeRealmSlug(realm: string): string`, used by `getCharacterEquipment(region, realm, name)`.
- Verifies: the request URL for `Tarren Mill` contains `/tarren-mill/` and an accented character remains lowercased and percent-encoded.

- [ ] **Step 1: Write the failing request-path test**

Change the existing equipment-profile test input to use `Tarren Mill` and an uppercase accented character such as `Tëst Chàr`. Assert the second HTTP request URL is exactly:

```ts
expect(httpRequest).toHaveBeenNthCalledWith(
  2,
  'blizzard',
  'https://eu.api.blizzard.com/profile/wow/character/tarren-mill/t%C3%ABst%20ch%C3%A0r/equipment?namespace=profile-eu&locale=en_GB',
  expect.objectContaining({ headers: { Authorization: 'Bearer test-token' } }),
);
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```powershell
npm test -- tests/unit/blizzard.test.ts
```

Expected: FAIL because the current path includes `tarren%20mill`.

- [ ] **Step 3: Add the minimal realm normalizer**

Add a module-local helper and apply it to the equipment endpoint’s realm segment:

```ts
function normalizeRealmSlug(realm: string): string {
  return realm.trim().toLowerCase().replace(/\s+/g, '-');
}

const realmSlug = encodeURIComponent(normalizeRealmSlug(realm));
```

Keep `encodeURIComponent(name.toLowerCase())` unchanged.

- [ ] **Step 4: Run focused tests to verify they pass**

Run:

```powershell
npm test -- tests/unit/blizzard.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run static and full verification**

Run with disposable required configuration values:

```powershell
npm run typecheck
npm run lint
npm test
npx prettier --check src/services/blizzard.ts tests/unit/blizzard.test.ts
git diff --check
```

Expected: all commands pass, apart from any already-known non-fatal `node-cron` sourcemap warning.

- [ ] **Step 6: Commit the implementation**

```powershell
git add src/services/blizzard.ts tests/unit/blizzard.test.ts
git commit -m "fix: normalize Blizzard realm slugs"
```

## Self-review

- Spec coverage: Task 1 covers realm trimming, lowercasing, whitespace-to-hyphen conversion, character encoding preservation, and regression verification.
- Placeholder scan: no deferred implementation markers or unspecified test cases remain.
- Type consistency: `normalizeRealmSlug` accepts the existing string realm input and `getCharacterEquipment` keeps its public signature.

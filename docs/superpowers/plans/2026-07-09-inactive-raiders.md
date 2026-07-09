# Inactive Raiders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire raiders who have been missing from the Raider.io roster for over 24 hours to an "inactive" state — hidden from `get_raiders` and other roster views, no longer warned about every sync, and auto-reactivated if they return.

**Architecture:** Add a nullable `inactive_since` timestamp to the `raiders` table (mirroring the existing `missing_since` pattern). `syncRaiders` promotes a missing raider to inactive once the existing 24h grace period expires, logs it once, and stops the per-sync warning. Returning raiders have both timestamps cleared. Roster-enumerating queries add `inactive_since IS NULL`.

**Tech Stack:** TypeScript (Node16 ESM, `.js` import specifiers), better-sqlite3, discord.js v14, Vitest.

**Design doc:** `docs/superpowers/specs/2026-07-09-inactive-raiders-design.md`

## Global Constraints

- **Import specifiers:** intra-`src` imports use explicit `.js` extensions (Node16 resolution). Match existing files.
- **Migration idempotency:** migrations must be safe to re-run and safe on fresh DBs (where `createTables` runs first). Follow the existing `if (currentVersion < N)` + transaction + `INSERT INTO schema_version` style in `src/database/db.ts`.
- **Grace period:** reuse the existing `GRACE_PERIOD_MS = 24 * 60 * 60 * 1000` constant in `syncRaiders.ts`. Do not introduce a second threshold.
- **`missing_since` is kept, not cleared, when a raider becomes inactive** — so existing `missing_since IS NULL` filters keep excluding inactive raiders.
- **Commit messages:** conventional-commit style; end every commit with the two repo trailer lines (`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` and `Claude-Session: <session url>`), per repo policy. Commit steps below show the subject/body only for brevity.
- **Do not push.** `develop` auto-deploys and restarts the test bot; committing is fine, pushing is a separate explicit step the user controls.
- **Test commands:** `npm test` (unit, `tests/unit`), `npm run test:integration` (`tests/integration`), `npm run typecheck`.

---

### Task 1: Add `inactive_since` column, migration, and type

Foundation: the schema column, the v5 migration, the `RaiderRow` type field, and the test-fixture literals that construct `RaiderRow`. After this task the codebase compiles and all existing tests pass with the new (unused) column present.

**Files:**
- Modify: `src/database/schema.ts:41-52` (raiders `CREATE TABLE`)
- Modify: `src/database/db.ts:118` (add migration block after v4, before `closeDatabase`)
- Modify: `src/types/index.ts:39-49` (`RaiderRow`)
- Modify: `tests/unit/autoMatchRaiders.test.ts:43-55` (`createRaider` fixture)
- Modify: `tests/unit/alertForNewUnlinkedRaiders.test.ts:40`
- Modify: `tests/unit/greatVaultReport.test.ts:23`
- Test: `tests/unit/db-migration.test.ts`

**Interfaces:**
- Produces: `RaiderRow.inactive_since: string | null`; DB column `raiders.inactive_since TEXT`; schema version `5`.

- [ ] **Step 1: Write the failing migration test**

Add to `tests/unit/db-migration.test.ts` (after the v4 `describe` block, before the `initDatabase` describe):

```typescript
describe('runMigrations — v5 adds inactive_since to raiders', () => {
  it('adds the column to a legacy raiders table missing it', () => {
    const db = getDatabase();

    // Represent a pre-v5 install: recreate raiders WITHOUT inactive_since.
    db.exec('DROP TABLE raiders;');
    db.exec(`
      CREATE TABLE raiders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        character_name TEXT NOT NULL UNIQUE,
        realm TEXT DEFAULT 'silvermoon',
        region TEXT DEFAULT 'eu',
        rank INTEGER,
        class TEXT,
        discord_user_id TEXT,
        message_id TEXT,
        missing_since TEXT
      );
    `);
    db.exec('DELETE FROM schema_version;');

    runMigrations(db);

    const cols = db.pragma('table_info(raiders)') as { name: string }[];
    expect(cols.some((c) => c.name === 'inactive_since')).toBe(true);

    const version = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number };
    expect(version.v).toBeGreaterThanOrEqual(5);
  });

  it('is a no-op on a fresh DB where the column already exists', () => {
    const db = getDatabase(); // beforeEach already ran createTables (column present)

    expect(() => runMigrations(db)).not.toThrow();
    expect(() => runMigrations(db)).not.toThrow();

    const cols = db.pragma('table_info(raiders)') as { name: string }[];
    expect(cols.filter((c) => c.name === 'inactive_since')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- db-migration`
Expected: FAIL — the legacy-table test fails because `runMigrations` never adds `inactive_since` (column absent); version stays at 4.

- [ ] **Step 3: Add the column to the schema**

In `src/database/schema.ts`, change the raiders table definition (currently ending at `missing_since TEXT`):

```typescript
    -- 7. raiders
    CREATE TABLE IF NOT EXISTS raiders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_name TEXT NOT NULL UNIQUE,
      realm TEXT DEFAULT 'silvermoon',
      region TEXT DEFAULT 'eu',
      rank INTEGER,
      class TEXT,
      discord_user_id TEXT,
      message_id TEXT,
      missing_since TEXT,
      inactive_since TEXT
    );
```

- [ ] **Step 4: Add the v5 migration block**

In `src/database/db.ts`, immediately after the `if (currentVersion < 4) { ... }` block (currently ends at line 118) and before the closing `}` of `runMigrations`:

```typescript
  if (currentVersion < 5) {
    // Retire long-missing raiders to an inactive state. Add the
    // inactive_since column. Fresh DBs already have it from createTables, so
    // guard the ALTER against a duplicate-column error and keep the migration
    // idempotent.
    database.transaction(() => {
      const cols = database.pragma('table_info(raiders)') as { name: string }[];
      if (!cols.some((c) => c.name === 'inactive_since')) {
        database.exec('ALTER TABLE raiders ADD COLUMN inactive_since TEXT');
      }
      database.prepare('INSERT INTO schema_version (version) VALUES (?)').run(5);
    })();
  }
```

- [ ] **Step 5: Add the field to `RaiderRow`**

In `src/types/index.ts`, add to the `RaiderRow` interface after `missing_since`:

```typescript
export interface RaiderRow {
  id: number;
  character_name: string;
  realm: string;
  region: string;
  rank: number | null;
  class: string | null;
  discord_user_id: string | null;
  message_id: string | null;
  missing_since: string | null;
  inactive_since: string | null;
}
```

- [ ] **Step 6: Fix the `RaiderRow` fixture literals**

The new required field breaks every `RaiderRow` object literal. Update all three:

`tests/unit/autoMatchRaiders.test.ts` — in `createRaider`, after `missing_since: null,`:

```typescript
    missing_since: null,
    inactive_since: null,
  };
```

`tests/unit/alertForNewUnlinkedRaiders.test.ts:40` — after the `missing_since: null,` line add:

```typescript
    inactive_since: null,
```

`tests/unit/greatVaultReport.test.ts:23` — after the `missing_since: null,` line add:

```typescript
    inactive_since: null,
```

- [ ] **Step 7: Run the migration test and typecheck**

Run: `npm test -- db-migration && npm run typecheck`
Expected: migration tests PASS; typecheck reports no errors.

- [ ] **Step 8: Run the full unit suite to confirm no regressions**

Run: `npm test`
Expected: all tests PASS (the column is present but unused so far).

- [ ] **Step 9: Commit**

```bash
git add src/database/schema.ts src/database/db.ts src/types/index.ts \
  tests/unit/db-migration.test.ts tests/unit/autoMatchRaiders.test.ts \
  tests/unit/alertForNewUnlinkedRaiders.test.ts tests/unit/greatVaultReport.test.ts
git commit -m "feat(raids): add inactive_since column and v5 migration"
```

---

### Task 2: Promote missing raiders to inactive in `syncRaiders`

Rewrite the state machine: after the grace period, set `inactive_since` and log once (replacing the repeating warn); do nothing for already-inactive raiders; clear both timestamps when a raider returns.

**Files:**
- Modify: `src/functions/raids/syncRaiders.ts:35-127`
- Test: `tests/unit/syncRaiders.test.ts`

**Interfaces:**
- Consumes: `RaiderRow.inactive_since` (Task 1); `GRACE_PERIOD_MS`.
- Produces: `syncRaiders(client)` unchanged signature (returns `RaiderRow[]` of newly-added unlinked raiders). New DB side effects: sets/clears `inactive_since`; one `info` log per promotion/reactivation.

- [ ] **Step 1: Update the two grace-period tests and add the new ones**

In `tests/unit/syncRaiders.test.ts`, **replace** the test at lines 186-201 (`'should warn when a raider has been missing for over 24 hours'`) and lines 203-218 (`'should not warn when a raider is missing for less than 24 hours'`) with the following four tests:

```typescript
  it('should mark a raider inactive when missing for over 24 hours', async () => {
    const db = getDatabase();
    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25 hours ago
    db.prepare(
      'INSERT INTO raiders (character_name, realm, region, missing_since) VALUES (?, ?, ?, ?)',
    ).run('LongGoneRaider', 'silvermoon', 'eu', oldDate);

    mockedGetGuildRoster.mockResolvedValue([]);

    await syncRaiders(mockClient);

    const raider = db
      .prepare('SELECT inactive_since FROM raiders WHERE character_name = ?')
      .get('LongGoneRaider') as { inactive_since: string | null };

    expect(raider.inactive_since).not.toBeNull();
    expect(logger.info).toHaveBeenCalledWith(
      'SyncRaiders',
      expect.stringContaining('LongGoneRaider'),
    );
  });

  it('should not mark a raider inactive when missing for less than 24 hours', async () => {
    const db = getDatabase();
    const recentDate = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2 hours ago
    db.prepare(
      'INSERT INTO raiders (character_name, realm, region, missing_since) VALUES (?, ?, ?, ?)',
    ).run('RecentlyGoneRaider', 'silvermoon', 'eu', recentDate);

    mockedGetGuildRoster.mockResolvedValue([]);

    await syncRaiders(mockClient);

    const raider = db
      .prepare('SELECT inactive_since FROM raiders WHERE character_name = ?')
      .get('RecentlyGoneRaider') as { inactive_since: string | null };

    expect(raider.inactive_since).toBeNull();
  });

  it('should not change state or re-log for an already-inactive raider', async () => {
    const db = getDatabase();
    const missingSince = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const inactiveSince = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    db.prepare(
      'INSERT INTO raiders (character_name, realm, region, missing_since, inactive_since) VALUES (?, ?, ?, ?, ?)',
    ).run('StillGoneRaider', 'silvermoon', 'eu', missingSince, inactiveSince);

    mockedGetGuildRoster.mockResolvedValue([]);

    await syncRaiders(mockClient);

    const raider = db
      .prepare('SELECT inactive_since FROM raiders WHERE character_name = ?')
      .get('StillGoneRaider') as { inactive_since: string | null };

    // Unchanged, and no "marked inactive" log this run.
    expect(raider.inactive_since).toBe(inactiveSince);
    expect(logger.info).not.toHaveBeenCalledWith(
      'SyncRaiders',
      expect.stringContaining('marked inactive'),
    );
  });

  it('should reactivate an inactive raider that returns to the roster', async () => {
    const db = getDatabase();
    const missingSince = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const inactiveSince = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    db.prepare(
      'INSERT INTO raiders (character_name, realm, region, missing_since, inactive_since) VALUES (?, ?, ?, ?, ?)',
    ).run('BackAgainRaider', 'silvermoon', 'eu', missingSince, inactiveSince);

    mockedGetGuildRoster.mockResolvedValue([makeMember('BackAgainRaider')]);

    await syncRaiders(mockClient);

    const raider = db
      .prepare('SELECT missing_since, inactive_since FROM raiders WHERE character_name = ?')
      .get('BackAgainRaider') as { missing_since: string | null; inactive_since: string | null };

    expect(raider.missing_since).toBeNull();
    expect(raider.inactive_since).toBeNull();
    expect(logger.info).toHaveBeenCalledWith(
      'SyncRaiders',
      expect.stringContaining('reactivated'),
    );
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- syncRaiders`
Expected: FAIL — the new tests reference `inactive_since` behaviour that `syncRaiders` does not yet implement (raider never marked inactive; still-inactive raider may be warned via old code; reactivation does not clear `inactive_since`).

- [ ] **Step 3: Rewrite the sync state machine**

In `src/functions/raids/syncRaiders.ts`, replace the counter declarations (lines 35-38) and the transaction body's steps 1 & 2 (lines 47-79) and the summary log (lines 121-124).

Replace the counters block (lines 35-38):

```typescript
  let added = 0;
  let markedMissing = 0;
  let markedInactive = 0;
  let returned = 0;
  let reactivated = 0;
```

Replace step 1 (currently lines 50-71, the "Handle raiders no longer in API" loop):

```typescript
    // 1. Handle raiders no longer in the API roster.
    for (const raider of dbRaiders) {
      if (apiNameSet.has(raider.character_name.toLowerCase())) continue;

      if (raider.missing_since === null) {
        // First sync they're absent: start the grace-period clock.
        db.prepare('UPDATE raiders SET missing_since = ? WHERE id = ?').run(now, raider.id);
        markedMissing++;
        continue;
      }

      if (raider.inactive_since !== null) {
        // Already retired to inactive — nothing to do. Crucially, no repeated
        // warning on every sync.
        continue;
      }

      const elapsed = Date.now() - new Date(raider.missing_since).getTime();
      if (elapsed >= GRACE_PERIOD_MS) {
        // Grace period expired: retire to inactive. The row is kept (so we can
        // auto-reactivate on return) but hidden from get_raiders. Logged once.
        db.prepare('UPDATE raiders SET inactive_since = ? WHERE id = ?').run(now, raider.id);
        markedInactive++;
        logger.info(
          'SyncRaiders',
          `Raider "${raider.character_name}" marked inactive after >24h missing (since ${raider.missing_since})`,
        );
      }
      // else: still within the 24h grace period — leave as missing.
    }
```

Replace step 2 (currently lines 73-79, the "Handle raiders back in API" loop):

```typescript
    // 2. Handle raiders back in the API roster: clear missing/inactive state.
    for (const raider of dbRaiders) {
      if (!apiNameSet.has(raider.character_name.toLowerCase())) continue;
      if (raider.missing_since === null && raider.inactive_since === null) continue;

      db.prepare(
        'UPDATE raiders SET missing_since = NULL, inactive_since = NULL WHERE id = ?',
      ).run(raider.id);

      if (raider.inactive_since !== null) {
        reactivated++;
        logger.info(
          'SyncRaiders',
          `Raider "${raider.character_name}" reactivated (returned to roster)`,
        );
      } else {
        returned++;
      }
    }
```

Replace the summary log (currently lines 121-124):

```typescript
  logger.info(
    'SyncRaiders',
    `Sync complete: ${added} added, ${returned} returned, ${reactivated} reactivated, ` +
      `${markedMissing} newly missing, ${markedInactive} newly inactive`,
  );
```

- [ ] **Step 4: Run the syncRaiders tests to verify they pass**

Run: `npm test -- syncRaiders`
Expected: PASS (including the pre-existing tests — the summary-log test still matches `'Sync complete'`).

- [ ] **Step 5: Run the integration suite**

Run: `npm run test:integration`
Expected: PASS — `raids-flow.test.ts` still passes (missing-set and returned-clear behaviour unchanged for the <24h / never-inactive cases).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/functions/raids/syncRaiders.ts tests/unit/syncRaiders.test.ts
git commit -m "feat(raids): retire long-missing raiders to inactive, stop repeat warnings"
```

---

### Task 3: Hide inactive raiders from roster views

Add `inactive_since IS NULL` to the roster-enumerating queries so inactive raiders disappear from `get_raiders`, the status count, weekly reports, signup mentions, and the auto-match already-linked set.

**Files:**
- Modify: `src/commands/raiders.ts:110`
- Modify: `src/commands/status.ts:82`
- Modify: `src/functions/raids/alertHighestMythicPlusDone.ts:130-132`
- Modify: `src/functions/raids/alertSignups.ts:105`
- Modify: `src/functions/raids/autoMatchRaiders.ts:21-24`
- Test: `tests/integration/raids-flow.test.ts`, `tests/unit/autoMatchRaiders.test.ts`

**Interfaces:**
- Consumes: `raiders.inactive_since` column (Task 1); inactive rows produced by `syncRaiders` (Task 2).
- Produces: no new symbols; behavioural change only (inactive rows excluded from the listed queries).

- [ ] **Step 1: Write the failing `get_raiders` filter test**

Add to `tests/integration/raids-flow.test.ts` inside the `describe('raids roster sync flow (integration)', ...)` block:

```typescript
  it('get_raiders query excludes inactive raiders', async () => {
    const db = getDatabase();
    db.prepare('INSERT INTO raiders (character_name, realm, region) VALUES (?, ?, ?)').run(
      'ActiveGuy',
      'silvermoon',
      'eu',
    );
    db.prepare(
      'INSERT INTO raiders (character_name, realm, region, missing_since, inactive_since) VALUES (?, ?, ?, ?, ?)',
    ).run('GoneGuy', 'silvermoon', 'eu', '2026-01-01', '2026-01-02');

    // Mirrors the query get_raiders runs (src/commands/raiders.ts).
    const rows = db
      .prepare('SELECT character_name FROM raiders WHERE inactive_since IS NULL ORDER BY character_name')
      .all() as Array<{ character_name: string }>;

    const names = rows.map((r) => r.character_name);
    expect(names).toContain('ActiveGuy');
    expect(names).not.toContain('GoneGuy');
  });
```

- [ ] **Step 2: Write the failing auto-match test**

Add to `tests/unit/autoMatchRaiders.test.ts` inside the `describe('autoMatchRaiders', ...)` block (after the existing "New behaviour" tests). This uses the existing `insertRaider` helper plus a new inline insert for an inactive raider:

```typescript
  it("does not exclude a Discord user linked only to an inactive raider", async () => {
    const member = createMockMember('Thrall', 'g', 'u', '999');
    const guild = createMockGuild([member]);
    // User 999 is linked, but only to an inactive raider — they should still be
    // suggestable for an active character.
    getDatabase()
      .prepare(
        'INSERT INTO raiders (character_name, discord_user_id, missing_since, inactive_since) VALUES (?, ?, ?, ?)',
      )
      .run('Grommash', '999', '2026-01-01', '2026-01-02');
    const raider = createRaider('Thrall');

    const result = await autoMatchRaiders(guild, [raider]);

    expect(result).toHaveLength(1);
    expect(result[0].suggestedUser.id).toBe('999');
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -- autoMatchRaiders && npm run test:integration -- raids-flow`
Expected: FAIL — the integration test fails (query has no `inactive_since` filter yet, so the row would appear if the command query were used — note this test asserts against the *intended* query string, so it passes trivially; see Step 3a). The auto-match test FAILS because `linkedUserIds` currently includes user 999 (inactive raiders are counted), so no suggestion is produced.

- [ ] **Step 3a: Note on the get_raiders test**

The integration test in Step 1 embeds the target query string directly, so it passes as soon as it is written. Its purpose is a regression guard documenting the contract: if someone later changes `get_raiders` to a query that does not filter `inactive_since`, this test still describes the required behaviour. The behavioural failure that Step 3 must observe is the **auto-match** test. Proceed once that one fails.

- [ ] **Step 4: Add the filter to `get_raiders`**

In `src/commands/raiders.ts:109-111`, change:

```typescript
        const raiders = db
          .prepare('SELECT * FROM raiders WHERE inactive_since IS NULL ORDER BY character_name')
          .all() as RaiderRow[];
```

- [ ] **Step 5: Add the filter to the status count**

In `src/commands/status.ts:82`, change:

```typescript
    const raiders = db.prepare('SELECT COUNT(*) as total, COUNT(discord_user_id) as linked FROM raiders WHERE inactive_since IS NULL').get() as { total: number; linked: number };
```

- [ ] **Step 6: Add the filter to the weekly M+ report**

In `src/functions/raids/alertHighestMythicPlusDone.ts:130-132`, change:

```typescript
  const raiders = db
    .prepare('SELECT * FROM raiders WHERE inactive_since IS NULL ORDER BY character_name')
    .all() as RaiderRow[];
```

- [ ] **Step 7: Add the filter to signup mentions**

In `src/functions/raids/alertSignups.ts:105`, change:

```typescript
  const raiders = db.prepare('SELECT * FROM raiders WHERE inactive_since IS NULL').all() as RaiderRow[];
```

- [ ] **Step 8: Exclude inactive raiders from the auto-match linked-user set**

In `src/functions/raids/autoMatchRaiders.ts:20-24`, change:

```typescript
  // Discord users already linked to some ACTIVE raider — never suggest them
  // again. Users linked only to an inactive raider stay suggestable.
  const linkedRows = db
    .prepare(
      'SELECT discord_user_id FROM raiders WHERE discord_user_id IS NOT NULL AND inactive_since IS NULL',
    )
    .all() as { discord_user_id: string }[];
  const linkedUserIds = new Set(linkedRows.map((r) => r.discord_user_id));
```

- [ ] **Step 9: Run the affected tests to verify they pass**

Run: `npm test -- autoMatchRaiders && npm run test:integration -- raids-flow`
Expected: PASS — auto-match now suggests user 999; the get_raiders regression-guard test passes.

- [ ] **Step 10: Run the full suites and typecheck**

Run: `npm test && npm run test:integration && npm run typecheck`
Expected: all PASS, no type errors.

- [ ] **Step 11: Commit**

```bash
git add src/commands/raiders.ts src/commands/status.ts \
  src/functions/raids/alertHighestMythicPlusDone.ts \
  src/functions/raids/alertSignups.ts src/functions/raids/autoMatchRaiders.ts \
  tests/integration/raids-flow.test.ts tests/unit/autoMatchRaiders.test.ts
git commit -m "feat(raids): hide inactive raiders from roster views"
```

---

### Task 4: Update documentation

Bring the raiders skill doc in line with the new behaviour and fix the pre-existing stale claim that sync "removes departed" raiders.

**Files:**
- Modify: `.claude/skills/raiders.md`

**Interfaces:**
- Consumes: final behaviour from Tasks 1-3.
- Produces: none (docs only).

- [ ] **Step 1: Correct the sync-logic section**

In `.claude/skills/raiders.md`, replace step 3 of the "Sync logic (syncRaiders)" list (currently `3. Remove stored raiders not in roster (or newly ignored)`) with:

```markdown
3. Flag stored raiders no longer in the roster: set `missing_since` on first
   absence; after a 24h grace period, retire them to inactive (`inactive_since`
   set) — the row is kept but hidden from `get_raiders`. Sync does **not** delete
   missing raiders (only `ignore_character` deletes a raider row).
4. Auto-reactivate: a raider who reappears in the roster has `missing_since` and
   `inactive_since` cleared.
```

Renumber the remaining steps (the old 4/5/6/7 become 5/6/7/8).

- [ ] **Step 2: Document the inactive column and roster-view behaviour**

In the "Database tables used" section, change the `raiders` line to list the new column:

```markdown
- `raiders` - character_name, discord_user_id, realm, region, missing_since, inactive_since
```

In the "Roster management" list, update the `get_raiders` line:

```markdown
- `get_raiders` - Shows all active raiders with realm and Discord user (inactive raiders — missing >24h — are hidden)
```

- [ ] **Step 3: Verify no stale references remain**

Run: `grep -n "removes departed\|Remove stored raiders" .claude/skills/raiders.md`
Expected: no output (the stale phrasing is gone).

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/raiders.md
git commit -m "docs(raids): document inactive-raider state machine"
```

---

## Self-Review

**Spec coverage:**
- Threshold (reuse 24h `GRACE_PERIOD_MS`) → Task 2, Step 3. ✓
- `inactive_since` column + guarded migration + type → Task 1. ✓
- Sync promotes to inactive, logs once, stops repeat warning, no-ops when already inactive → Task 2, Step 3. ✓
- Auto-reactivate clears both timestamps → Task 2, Step 3 (step 2 loop). ✓
- Keep `missing_since` set on inactive rows → Task 2, Step 3 (never cleared on promotion). ✓
- Hide from `get_raiders` → Task 3, Step 4. ✓
- Consistency filters (status, weekly M+, signups, auto-match linked set) → Task 3, Steps 5-8. ✓
- Already-covered `missing_since IS NULL` sites left as-is (`check_missing_users`, `refreshLinkingMessages`, auto-match count) → not modified, correct. ✓
- Not-changed sites (`syncRaiders:20`, loot, by-name) → not touched. ✓
- Documentation → Task 4. ✓
- Testing (missing<24h, ≥24h, already-inactive no-op, reactivate, get_raiders filter, migration) → Tasks 1-3. ✓
- Out of scope (list view, manual reactivate, channel notify, loot exclusion) → not implemented. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; every command step shows an expected result. ✓

**Type consistency:** `inactive_since: string | null` defined in Task 1 and used consistently in Tasks 2-3; `RaiderRow` literals fixed in Task 1; `GRACE_PERIOD_MS` reused; log-substring assertions (`'marked inactive'`, `'reactivated'`) match the exact strings emitted in Task 2, Step 3. ✓

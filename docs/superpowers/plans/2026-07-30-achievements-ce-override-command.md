# Achievements CE Override Command and Legion Icons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let officers persist a per-raid CE cutoff through Discord, preserve it across cache flushes, and render icons for every Legion raid.

**Architecture:** A new `achievement_ce_overrides` SQLite table stores an exclusive UTC cutoff by Raider.IO raid slug. A focused `ceOverrides` service validates and manages those records; the achievements model uses it only to choose the CE cutoff, while raid ordering and API-cache freshness still use Raider.IO. The new `/ceoverride` command changes the record and refreshes the image. Legion row icons are resolved from a local slug fallback map only when Raider.IO omits the icon.

**Tech Stack:** TypeScript (Node16 ESM), discord.js v14, better-sqlite3, Vitest.

## Global Constraints

- `achievement_ce_overrides` is persistent business data; `flushCache()` must continue to delete only `api_cache` and `icon_cache`.
- Cutoffs are exclusive UTC midnights. `2026-01-21` means kills on or after `2026-01-21T00:00:00.000Z` are not CE.
- `/ceoverride` requires both Discord Administrator default permissions and the existing runtime `requireOfficer()` check.
- A successful database change is retained if image regeneration fails; the response must clearly say that it was saved but not refreshed.
- Retain Raider.IO `ends.eu` for raid ordering and static-data cache freshness.
- Run `npm run format:check` before pushing. Use `npm run format` if it finds drift.
- Do not stage unrelated user changes in `src/commands/test.ts`, `src/events/ready.ts`, `src/functions/maintenance/runDailyMaintenance.ts`, or `tests/unit/runDailyMaintenance.test.ts`.

---

### Task 1: Persistent CE override storage and migration

**Files:**
- Modify: `src/database/schema.ts`
- Modify: `src/database/db.ts`
- Modify: `src/types/index.ts`
- Create: `src/functions/guild-info/ceOverrides.ts`
- Modify: `tests/integration/database-schema.test.ts`
- Create: `tests/unit/ceOverrides.test.ts`
- Modify: `tests/unit/apiCache.test.ts`

**Interfaces:**
- Produces `CeOverrideRow { raid_slug: string; cutoff_at: string }`.
- Produces `parseCeCutoffDate(input: string): string | null`, `getCeOverrideCutoff(raidSlug: string): string | null`, `setCeOverride(raidSlug: string, cutoffAt: string): void`, and `removeCeOverride(raidSlug: string): boolean`.
- Creates `achievement_ce_overrides(raid_slug TEXT PRIMARY KEY, cutoff_at TEXT NOT NULL)` at schema version 10.

- [ ] **Step 1: Write the failing schema and service tests**

Add the table assertion and schema-version expectation to `tests/integration/database-schema.test.ts`:

```ts
expect(tableNames).toContain('achievement_ce_overrides');
expect(version.version).toBe(10);
```

Create `tests/unit/ceOverrides.test.ts` with an in-memory database lifecycle and these behaviours:

```ts
it('accepts one real UTC calendar date and normalizes it to an exclusive midnight', () => {
  expect(parseCeCutoffDate('2026-01-21')).toBe('2026-01-21T00:00:00.000Z');
  expect(parseCeCutoffDate('2026-02-29')).toBeNull();
  expect(parseCeCutoffDate('21/01/2026')).toBeNull();
});

it('upserts, reads, and removes a raid cutoff', () => {
  setCeOverride('manaforge-omega', '2026-01-21T00:00:00.000Z');
  expect(getCeOverrideCutoff('manaforge-omega')).toBe('2026-01-21T00:00:00.000Z');
  setCeOverride('manaforge-omega', '2026-01-22T00:00:00.000Z');
  expect(getCeOverrideCutoff('manaforge-omega')).toBe('2026-01-22T00:00:00.000Z');
  expect(removeCeOverride('manaforge-omega')).toBe(true);
  expect(removeCeOverride('manaforge-omega')).toBe(false);
});
```

Extend `tests/unit/apiCache.test.ts` with a regression test that writes an override, calls `flushCache()`, and confirms the override remains:

```ts
setCeOverride('manaforge-omega', '2026-01-21T00:00:00.000Z');
flushCache();
expect(getCeOverrideCutoff('manaforge-omega')).toBe('2026-01-21T00:00:00.000Z');
```

- [ ] **Step 2: Run the new tests and verify they fail**

Run:

```bash
npm test -- ceOverrides apiCache
npm run test:integration -- database-schema
```

Expected: the unit suite cannot import `ceOverrides.js`; the integration suite reports the missing table/version 10.

- [ ] **Step 3: Implement the migration and service**

Add this table at the end of `createTables` in `src/database/schema.ts`:

```sql
    -- 28. achievement_ce_overrides (officer-managed CE cutoffs, not cache data)
    CREATE TABLE IF NOT EXISTS achievement_ce_overrides (
      raid_slug TEXT PRIMARY KEY,
      cutoff_at TEXT NOT NULL
    );
```

Append a v10, `CREATE TABLE IF NOT EXISTS` migration transaction in `runMigrations`, then insert schema version 10. Add the row type to `src/types/index.ts`.

Create `src/functions/guild-info/ceOverrides.ts`. The parser must first enforce `/^\\d{4}-\\d{2}-\\d{2}$/`, construct `${input}T00:00:00.000Z`, and reject it unless `toISOString().slice(0, 10) === input`. Use a parameterized `INSERT OR REPLACE` for upsert, a parameterized `SELECT cutoff_at`, and return `deleteResult.changes > 0` for removal.

- [ ] **Step 4: Run the focused tests and verify they pass**

Run:

```bash
npm test -- ceOverrides apiCache
npm run test:integration -- database-schema
```

Expected: all focused unit and integration tests pass, including the proof that cache flush does not remove an override.

- [ ] **Step 5: Commit the persistence deliverable**

```bash
git add src/database/schema.ts src/database/db.ts src/types/index.ts src/functions/guild-info/ceOverrides.ts tests/integration/database-schema.test.ts tests/unit/ceOverrides.test.ts tests/unit/apiCache.test.ts
git commit -m "feat(achievements): persist CE cutoff overrides"
```

### Task 2: Apply stored cutoffs and Legion icon fallbacks to the image model

**Files:**
- Modify: `src/functions/guild-info/achievementsData.ts`
- Modify: `tests/unit/achievementsData.test.ts`

**Interfaces:**
- Consumes `getCeOverrideCutoff(raidSlug)` from `ceOverrides.ts`.
- Produces `raidIconName(raid: Pick<StaticRaid, 'slug' | 'icon'>): string | null` for icon selection.
- CE lookup uses the stored cutoff when present and otherwise `raid.ends.eu`.

- [ ] **Step 1: Write failing regression tests**

Extend `tests/unit/achievementsData.test.ts` with the fallback test:

```ts
it('uses a Legion fallback icon only when Raider.IO omits the raid icon', () => {
  expect(raidIconName({ slug: 'the-nighthold', icon: null })).toBe('achievement_thenighthold');
  expect(raidIconName({ slug: 'trial-of-valor', icon: null })).toBe('achievement_raid_trialofvalor');
  expect(raidIconName({ slug: 'the-nighthold', icon: 'raider-icon' })).toBe('raider-icon');
});
```

Add a model test that inserts `manaforge-omega` with cutoff `2026-01-21T00:00:00.000Z`, supplies its complete mythic standing and a final-boss kill at `2026-01-28T21:53:45.496Z`, then expects `isCE` to be false even when the Raider.IO `ends.eu` date is later. Add a matching no-override test to prove normal raids still use Raider.IO’s end date.

- [ ] **Step 2: Run the test file and verify it fails**

Run:

```bash
npm test -- achievementsData
```

Expected: `raidIconName` is not exported and the Manaforge row still receives CE using Raider.IO’s March date.

- [ ] **Step 3: Implement the minimal model changes**

Add the five-entry `LEGION_RAID_ICONS` map and this helper in `achievementsData.ts`:

```ts
const LEGION_RAID_ICONS: Record<string, string> = {
  'the-emerald-nightmare': 'achievement_emeraldnightmare_xavius',
  'the-nighthold': 'achievement_thenighthold',
  'trial-of-valor': 'achievement_raid_trialofvalor',
  'tomb-of-sargeras': 'achievement_boss_kiljaeden2',
  'antorus-the-burning-throne': 'achievement_boss_argus_worldsoul',
};

export function raidIconName(raid: Pick<StaticRaid, 'slug' | 'icon'>): string | null {
  return raid.icon ?? LEGION_RAID_ICONS[raid.slug] ?? null;
}
```

Use `raidIconName(raid)` when building every API row. In `resolveCE`, determine `tierEndsEu` with:

```ts
const tierEndsEu = getCeOverrideCutoff(raid.slug) ?? raid.ends.eu;
```

Use that value for both the ended-tier decision and the `determineCE` call. Do not alter `byEndDateDescending` or `staticDataFreshness`.

- [ ] **Step 4: Run the focused tests and verify they pass**

Run:

```bash
npm test -- achievementsData
```

Expected: all existing model tests plus the CE override and icon fallback regressions pass.

- [ ] **Step 5: Commit the image-model deliverable**

```bash
git add src/functions/guild-info/achievementsData.ts tests/unit/achievementsData.test.ts
git commit -m "fix(achievements): honor CE overrides and Legion icons"
```

### Task 3: Officer command, documentation, and end-to-end command behaviour

**Files:**
- Create: `src/commands/ceoverride.ts`
- Create: `tests/unit/ceOverrideCommand.test.ts`
- Modify: `docs/commands.md`

**Interfaces:**
- Creates `/ceoverride set raid:<slug> cutoff:<YYYY-MM-DD>` and `/ceoverride remove raid:<slug>`.
- Consumes the Task 1 CE override service and `updateAchievements`.
- Replies ephemerally; successful changes call `audit` and refresh the image.

- [ ] **Step 1: Write failing command tests**

Create `tests/unit/ceOverrideCommand.test.ts` using hoisted mocks for `requireOfficer`, `audit`, `setCeOverride`, `removeCeOverride`, `parseCeCutoffDate`, `updateAchievements`, and `logger.error`.

Define the local interaction factory used by each test:

```ts
function fakeInteraction(values: { subcommand: 'set' | 'remove'; raid: string; cutoff?: string }) {
  return {
    options: {
      getSubcommand: vi.fn().mockReturnValue(values.subcommand),
      getString: vi.fn((name: string) => (name === 'raid' ? values.raid : values.cutoff ?? null)),
    },
    reply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    client: {},
    user: {},
  };
}
```

```ts
it('sets the normalized cutoff, audits it, and refreshes achievements', async () => {
  mocks.parseCeCutoffDate.mockReturnValue('2026-01-21T00:00:00.000Z');
  const interaction = fakeInteraction({ subcommand: 'set', raid: 'manaforge-omega', cutoff: '2026-01-21' });
  await command.execute(interaction);
  expect(mocks.setCeOverride).toHaveBeenCalledWith('manaforge-omega', '2026-01-21T00:00:00.000Z');
  expect(mocks.updateAchievements).toHaveBeenCalledWith(interaction.client);
  expect(mocks.audit).toHaveBeenCalledWith(interaction.user, 'set CE override', 'manaforge-omega: 2026-01-21');
});

it('rejects an invalid cutoff before changing data or refreshing', async () => {
  mocks.parseCeCutoffDate.mockReturnValue(null);
  const interaction = fakeInteraction({ subcommand: 'set', raid: 'manaforge-omega', cutoff: '21/01/2026' });
  await command.execute(interaction);
  expect(mocks.setCeOverride).not.toHaveBeenCalled();
  expect(mocks.updateAchievements).not.toHaveBeenCalled();
  expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringMatching(/YYYY-MM-DD/) }));
});

it('keeps the saved override and says refresh failed when image generation rejects', async () => {
  mocks.parseCeCutoffDate.mockReturnValue('2026-01-21T00:00:00.000Z');
  mocks.updateAchievements.mockRejectedValue(new Error('raider.io down'));
  const interaction = fakeInteraction({ subcommand: 'set', raid: 'manaforge-omega', cutoff: '2026-01-21' });
  await command.execute(interaction);
  expect(mocks.setCeOverride).toHaveBeenCalled();
  expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringMatching(/saved.*refresh failed/i) }));
});

it('does not refresh or audit when remove finds no override', async () => {
  mocks.removeCeOverride.mockReturnValue(false);
  const interaction = fakeInteraction({ subcommand: 'remove', raid: 'manaforge-omega' });
  await command.execute(interaction);
  expect(mocks.updateAchievements).not.toHaveBeenCalled();
  expect(mocks.audit).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the command tests and verify they fail**

Run:

```bash
npm test -- ceOverrideCommand
```

Expected: Vitest cannot import `src/commands/ceoverride.js`.

- [ ] **Step 3: Implement the command and document it**

Create `src/commands/ceoverride.ts` with `PermissionFlagsBits.Administrator`, `requireOfficer()` at the start of `execute`, `set` and `remove` subcommands, and required `raid` string options. `set` also has required `cutoff` with the description “First non-CE day, YYYY-MM-DD UTC”.

For a valid change, reply `Saving CE override…` ephemerally before calling `updateAchievements`. On success, edit to a clear success message. On refresh failure, log the error and edit to `CE override saved for **<slug>**, but achievements refresh failed: <error>`; do not roll back the database row. For a missing removal, give an ephemeral `No CE override is set for **<slug>**.` reply without refreshing. Audit only actual set/remove changes.

Add both `/ceoverride` variants to `docs/commands.md`, including that `cutoff` is the first non-CE UTC date and that overrides survive `/updateachievements flush:true`.

- [ ] **Step 4: Run focused checks and verify they pass**

Run:

```bash
npm test -- ceOverrideCommand achievementsData ceOverrides apiCache
npm run test:integration -- database-schema
```

Expected: all override, command, icon, cache, and schema regressions pass.

- [ ] **Step 5: Commit the command deliverable**

```bash
git add src/commands/ceoverride.ts tests/unit/ceOverrideCommand.test.ts docs/commands.md
git commit -m "feat(achievements): add CE override command"
```

### Task 4: Full verification, review, deployment, and live use

**Files:**
- Verify all files from Tasks 1–3 only.

**Interfaces:**
- Confirms the shipped bot can register `/ceoverride` and retain its data through normal cache flushing.

- [ ] **Step 1: Run the complete local verification suite**

Run:

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
npm run test:integration
```

Expected: every command exits 0. If format check fails, run `npm run format`, inspect only intended files, and re-run `npm run format:check`.

- [ ] **Step 2: Request and address a code review**

Review the final diff specifically for: migration idempotence, parameterized SQL, date validation, cache-flush isolation, refresh-failure messaging, and all five Legion fallbacks. Fix any critical or important finding, then rerun the focused/full checks affected by the fix.

- [ ] **Step 3: Push and deploy command schema**

Run:

```bash
git push origin main
npm run deploy-commands
```

Expected: the push deploys Railway’s test environment and Discord accepts the new command schema.

- [ ] **Step 4: Manual test in the test environment**

After Railway reports the new deployment healthy, run:

```text
/ceoverride set raid:manaforge-omega cutoff:2026-01-21
/updateachievements flush:true
```

Verify Manaforge Omega is not marked CE after the set, the five Legion raid rows show their fallback icons, and a cache flush leaves the Manaforge result unchanged. Optionally run `/ceoverride remove raid:manaforge-omega` followed by another update to confirm removal restores the Raider.IO fallback behaviour.

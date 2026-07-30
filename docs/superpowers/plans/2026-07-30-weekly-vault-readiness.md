# Weekly Vault Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an accurate Great Vault activity view and a separate Wednesday readiness-exceptions message using Raider.IO for M+ and Blizzard equipment data for enchants and sockets.

**Architecture:** Keep external API concerns in typed services and keep Vault/readiness decisions in a dedicated raids helper module. The existing weekly job loads each raider's previous-week M+ data and Blizzard equipment data once, then passes that shared snapshot to attachment formatters and the exceptions formatter. Manual M+ and Great Vault commands load the same M+ snapshot so their output matches the scheduled job.

**Tech Stack:** TypeScript ESM, Node 22 `fetch`, Discord.js v14, Vitest, existing `httpRequest` retry/circuit-breaker wrapper.

## Global Constraints

- The report informs EP decisions only; it must not calculate, award, or persist EP.
- Do not add activity totals, affixes, seasonal score, timed status, or highlight sections to the weekly channel message.
- A completed `+10` qualifies whether it was timed or not.
- Dungeon Vault choices use the highest, fourth-highest, and eighth-highest completed previous-week runs; missing choices render `-`.
- Raid and World Vault columns show only the number of unlocked choices: `1`, `2`, or `3`.
- The exceptions message contains only non-empty sections and is not sent when there are no exceptions.
- Raider.IO remains the source for previous-week M+ runs and its `last_crawled_at` timestamp. Blizzard Character Equipment Profile is the source of truth for applied enchants and empty sockets.
- Use `WEEKLY_GEAR_STALE_HOURS`, defaulting to `48`, to classify an old or absent Raider.IO crawl timestamp as `Needs verification`; do not turn stale data into missing-gear claims.
- Required enchant slots are `BACK`, `CHEST`, `WRIST`, `WAIST`, `LEGS`, `FEET`, `FINGER_1`, `FINGER_2`, `MAIN_HAND`, and `OFF_HAND`. Inspect only equipped items in these inventory slots.

---

## File structure

- Create `src/services/blizzard.ts`: cache an application OAuth token and fetch a character's Blizzard equipment profile.
- Create `src/functions/raids/weeklyReadiness.ts`: define the shared weekly snapshot, derive Dungeon Vault choices, classify gear/M+ issues, and render the exceptions message.
- Modify `src/services/apiHealth.ts` and `src/commands/status.ts`: track and display the Blizzard service.
- Modify `src/services/raiderio.ts`: expose the previous-week runs together with `last_crawled_at`.
- Modify `src/functions/raids/alertHighestMythicPlusDone.ts`: load one snapshot per active raider, add Dungeon key choices to the Vault file, and post the optional exceptions message.
- Modify `src/commands/raiders.ts`: make both manual weekly-report commands use the same M+ snapshot as the scheduler.
- Modify `.env.example`, `README.md`, `docs/setup.md`, and `docs/services.md`: document the Battle.net credentials and the stale-age policy.
- Create `tests/unit/blizzard.test.ts` and `tests/unit/weeklyReadiness.test.ts`; extend `tests/unit/raiderio.test.ts`, `tests/unit/greatVaultReport.test.ts`, `tests/unit/apiHealth.test.ts`, and `tests/unit/config.test.ts`.

### Task 1: Battle.net equipment service and configuration

**Files:**
- Create: `src/services/blizzard.ts`
- Create: `tests/unit/blizzard.test.ts`
- Modify: `src/config.ts:3-60`
- Modify: `src/services/apiHealth.ts:1-42`
- Modify: `src/commands/status.ts:115-145`
- Modify: `tests/unit/config.test.ts`
- Modify: `tests/unit/apiHealth.test.ts`
- Modify: `.env.example`, `README.md`, `docs/setup.md`, `docs/services.md`

**Interfaces:**
- Produces `getCharacterEquipment(region, realm, name): Promise<BlizzardEquipmentProfile>`.
- Produces `BlizzardEquipmentProfile` with `equipped_items: BlizzardEquippedItem[]`.
- Produces `BlizzardEquippedItem` with `slot.type`, `item.name`, optional `enchantments`, and `sockets` whose optional `item` denotes a filled socket.
- Adds `blizzard` to `ServiceName`, enabling `httpRequest('blizzard', ...)`.

- [ ] **Step 1: Write failing configuration and health tests**

Add a config test that sets both credentials and asserts the exported values and 48-hour default. Extend the health enumeration assertion:

```ts
expect(config.blizzardClientId).toBe('test-blizzard-id');
expect(config.blizzardClientSecret).toBe('test-blizzard-secret');
expect(config.weeklyGearStaleHours).toBe(48);

expect(Object.keys(getAllSummaries()).sort()).toEqual([
  'blizzard',
  'raiderio',
  'warcraftlogs',
  'wowaudit',
]);
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `npm test -- tests/unit/config.test.ts tests/unit/apiHealth.test.ts`

Expected: FAIL because the Blizzard config properties and health service do not exist.

- [ ] **Step 3: Implement configuration, health, status, and documentation**

Add the two required credentials and the numeric stale-age option to `config`:

```ts
blizzardClientId: required('BLIZZARD_CLIENT_ID'),
blizzardClientSecret: required('BLIZZARD_CLIENT_SECRET'),
weeklyGearStaleHours: Number(optional('WEEKLY_GEAR_STALE_HOURS', '48')),
```

Validate `weeklyGearStaleHours` is finite and greater than zero before exporting config. Add `blizzard` to `ServiceName` and `SERVICES`, and add a fourth API-health line labelled `Blizzard` in `/status`. Add the three variables to `.env.example`, README, and setup documentation; add a Blizzard services section explaining its equipment endpoint and OAuth application credentials.

- [ ] **Step 4: Write failing Blizzard-service tests**

In `tests/unit/blizzard.test.ts`, mock `globalThis.fetch` for an OAuth token followed by an equipment response:

```ts
const profile = await getCharacterEquipment('eu', 'silvermoon', 'Tëst Chàr');
expect(profile.equipped_items[0].slot.type).toBe('BACK');
expect(globalThis.fetch).toHaveBeenNthCalledWith(
  2,
  expect.stringContaining('/profile/wow/character/silvermoon/t%C3%ABst%20ch%C3%A0r/equipment'),
  expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer token' }) }),
);
```

Add a second call assertion proving the cached token avoids a second OAuth request.

- [ ] **Step 5: Run the Blizzard test to verify it fails**

Run: `npm test -- tests/unit/blizzard.test.ts`

Expected: FAIL because `src/services/blizzard.ts` does not exist.

- [ ] **Step 6: Implement `src/services/blizzard.ts`**

Use the Warcraft Logs service's token-cache pattern, but post client credentials to `https://oauth.battle.net/token`. Use `httpRequest('blizzard', ...)` for both token and profile calls. Request:

```ts
const url =
  `https://${region}.api.blizzard.com/profile/wow/character/` +
  `${encodeURIComponent(realm)}/${encodeURIComponent(name)}/equipment` +
  `?namespace=profile-${region}&locale=en_GB`;
```

Cache the token until 60 seconds before expiry. Define only the response fields consumed by Task 2, preserving unknown upstream fields as unnecessary. Do not catch API failures in this service; Task 3 classifies them per raider.

- [ ] **Step 7: Run the focused tests to verify they pass**

Run: `npm test -- tests/unit/blizzard.test.ts tests/unit/config.test.ts tests/unit/apiHealth.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit the service layer**

```bash
git add src/services/blizzard.ts src/config.ts src/services/apiHealth.ts src/commands/status.ts \
  tests/unit/blizzard.test.ts tests/unit/config.test.ts tests/unit/apiHealth.test.ts \
  .env.example README.md docs/setup.md docs/services.md
git commit -m "feat: add Blizzard equipment service"
```

### Task 2: Pure Vault and readiness rules

**Files:**
- Create: `src/functions/raids/weeklyReadiness.ts`
- Create: `tests/unit/weeklyReadiness.test.ts`

**Interfaces:**
- Consumes `MythicPlusRun` from `src/services/raiderio.ts` and `BlizzardEquipmentProfile` from `src/services/blizzard.ts`.
- Produces `getDungeonVaultChoices(runs): [number | null, number | null, number | null]`.
- Produces `getUnlockedChoiceCount(vaultOptions): number`.
- Produces `buildReadinessExceptions(rows, now): string | null`.

- [ ] **Step 1: Write failing Vault-choice and exceptions tests**

Add tests with deliberately unsorted runs and confirm the 1st, 4th, and 8th highest levels are selected:

```ts
expect(getDungeonVaultChoices(runs([9, 10, 8, 9, 10, 9, 10, 10]))).toEqual([10, 10, 8]);
expect(getDungeonVaultChoices(runs([10, 9, 9, 9]))).toEqual([10, 9, null]);
```

Add a readiness fixture proving an untimed `+10` has no `No completed +10` entry, while a highest `+9` does. Include equipment with an empty socket (`{ socket_type: ..., item: undefined }`), an empty required enchantment list, and an old `lastCrawledAt`; assert the output has `Gear progression` and `Needs verification` sections. Assert `null` is returned when every list is empty.

- [ ] **Step 2: Run the unit test to verify it fails**

Run: `npm test -- tests/unit/weeklyReadiness.test.ts`

Expected: FAIL because `weeklyReadiness.ts` does not exist.

- [ ] **Step 3: Implement the pure helpers and formatter**

Implement the exact decision primitives:

```ts
export function getDungeonVaultChoices(runs: MythicPlusRun[]): DungeonVaultChoices {
  const levels = [...runs].map((run) => run.mythic_level).sort((a, b) => b - a);
  return [levels[0] ?? null, levels[3] ?? null, levels[7] ?? null];
}

export function hasCompletedTen(runs: MythicPlusRun[]): boolean {
  return runs.some((run) => run.mythic_level >= 10);
}
```

`getUnlockedChoiceCount` counts non-null `option_1`, `option_2`, and `option_3` values from one WoW Audit category. Gear classification must only report an empty socket when the equipment item contains a socket object with no `item`; it must report a missing enchant only for the ten global required slots and an empty or absent `enchantments` array. A missing equipment profile or `lastCrawledAt` older than `weeklyGearStaleHours` produces `Needs verification` and suppresses all gear-gap claims for that character.

Render only non-empty sections, in this order: `No completed +10`, `Dungeon Vault below +10`, `Gear progression`, `Needs verification`. Render Dungeon choices as `+10 / +9 / -`.

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `npm test -- tests/unit/weeklyReadiness.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the pure rules**

```bash
git add src/functions/raids/weeklyReadiness.ts tests/unit/weeklyReadiness.test.ts
git commit -m "feat: add weekly readiness rules"
```

### Task 3: Shared weekly data and report rendering

**Files:**
- Modify: `src/services/raiderio.ts:46-81`
- Modify: `tests/unit/raiderio.test.ts:189-225`
- Modify: `src/functions/raids/alertHighestMythicPlusDone.ts:1-191`
- Modify: `tests/unit/greatVaultReport.test.ts:28-69`

**Interfaces:**
- Produces `getPreviousWeekProfile(region, realm, name): Promise<{ runs: MythicPlusRun[]; lastCrawledAt: string | null }>`.
- Produces `loadWeeklyReadinessRows(raiders): Promise<WeeklyReadinessRow[]>` in the weekly reports module.
- Consumes `WeeklyReadinessRow[]` in `generateMythicPlusReport`, `generateGreatVaultReport`, and `buildReadinessExceptions`.

- [ ] **Step 1: Extend Raider.IO tests first**

Replace the direct weekly-run expectation with a profile response containing `last_crawled_at` and verify both fields are returned:

```ts
expect(await getPreviousWeekProfile('eu', 'silvermoon', 'Testchar')).toEqual({
  runs: mockRuns,
  lastCrawledAt: '2026-07-29T10:00:00Z',
});
```

- [ ] **Step 2: Run the focused Raider.IO test to verify it fails**

Run: `npm test -- tests/unit/raiderio.test.ts`

Expected: FAIL because `getPreviousWeekProfile` is not exported.

- [ ] **Step 3: Implement the richer Raider.IO profile wrapper**

Keep `getWeeklyMythicPlusRuns` as a compatibility wrapper that returns `.runs`. Add `getPreviousWeekProfile` to parse the existing endpoint response:

```ts
const data = await httpRequest<{
  mythic_plus_previous_weekly_highest_level_runs?: MythicPlusRun[];
  last_crawled_at?: string;
}>('raiderio', url);
return {
  runs: data.mythic_plus_previous_weekly_highest_level_runs ?? [],
  lastCrawledAt: data.last_crawled_at ?? null,
};
```

- [ ] **Step 4: Add failing report-format tests**

Extend `greatVaultReport.test.ts` to pass a named weekly-run map and assert the output contains `3`, `+10 / +9 / -`, and `1` for the Raid, Dungeon keys, and World columns. Add cases where only option one and option two exist, proving Raid/World counts are not rendered as slash-delimited reward values.

- [ ] **Step 5: Run the focused report test to verify it fails**

Run: `npm test -- tests/unit/greatVaultReport.test.ts`

Expected: FAIL because the renderer still prints `259/-/-` values and has no weekly-run input.

- [ ] **Step 6: Implement shared loading and renderers**

In `alertHighestMythicPlusDone.ts`, add `loadWeeklyReadinessRows(raiders)` that performs both service calls for each raider with `Promise.allSettled`. Preserve failures as `runs: null` or `equipment: null`; never convert an M+ fetch error into no activity. Log the character name and service-specific error once per failed lookup.

Change the Vault renderer to accept the loaded rows. Count non-null WoW Audit option values for `raids` and `world`; obtain the Dungeon display from `getDungeonVaultChoices(row.runs ?? [])`. The M+ attachment retains its current all-raider list, rendering `Error` when the M+ lookup failed. Do not add readiness content to either attachment.

- [ ] **Step 7: Run the focused tests to verify they pass**

Run: `npm test -- tests/unit/raiderio.test.ts tests/unit/greatVaultReport.test.ts tests/unit/weeklyReadiness.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit the report data changes**

```bash
git add src/services/raiderio.ts src/functions/raids/alertHighestMythicPlusDone.ts \
  tests/unit/raiderio.test.ts tests/unit/greatVaultReport.test.ts
git commit -m "feat: enrich weekly vault reports"
```

### Task 4: Scheduler, manual commands, and final verification

**Files:**
- Modify: `src/functions/raids/alertHighestMythicPlusDone.ts:128-191`
- Modify: `src/commands/raiders.ts:293-343`
- Modify: `tests/unit/greatVaultReport.test.ts`

**Interfaces:**
- Consumes `loadWeeklyReadinessRows`, `generateMythicPlusReport`, `generateGreatVaultReport`, and `buildReadinessExceptions` from Tasks 2 and 3.
- Produces exactly two existing attachments and, conditionally, one text-only exceptions message.

- [ ] **Step 1: Write the failing scheduler-send test**

Mock a text channel and a weekly snapshot that produces one readiness exception. Assert the first `channel.send` receives the existing `Weekly Reports` content and two files, and the second receives only the exceptions text. Add the no-exception case and assert `channel.send` is called once.

```ts
expect(channel.send).toHaveBeenNthCalledWith(2, {
  content: expect.stringContaining('Weekly Readiness Exceptions'),
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npm test -- tests/unit/greatVaultReport.test.ts`

Expected: FAIL because the scheduled function never posts a second message.

- [ ] **Step 3: Wire the scheduled job and manual commands**

Load the weekly snapshot once at the start of `alertHighestMythicPlusDone`, pass it to both attachment renderers, then call `buildReadinessExceptions(rows, new Date())`. Send the existing attachment message first. Send the returned exceptions text only when it is non-null; log but do not undo a successful attachment send if that second send fails.

For `/raiders previous_highest_mythicplus` and `/raiders previous_great_vault`, load the shared M+ snapshot before formatting so manual output uses the same previous-week levels and Dungeon Vault slots. Do not post the readiness exceptions from either manual command.

- [ ] **Step 4: Run focused, project, and formatting checks**

Run:

```bash
npm test -- tests/unit/blizzard.test.ts tests/unit/weeklyReadiness.test.ts tests/unit/raiderio.test.ts tests/unit/greatVaultReport.test.ts
npm test
npm run typecheck
npm run lint
npm run format:check
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 5: Commit the integration**

```bash
git add src/functions/raids/alertHighestMythicPlusDone.ts src/commands/raiders.ts tests/unit/greatVaultReport.test.ts
git commit -m "feat: post weekly readiness exceptions"
```

## Self-review

- The Great Vault file's `Raid`, `Dungeon keys`, and `World` columns are covered by Tasks 2 and 3.
- The separate no-EP exceptions post and no-message-empty rule are covered by Tasks 2 and 4.
- Untimed +10 qualification is covered by Task 2.
- Blizzard OAuth, slot-level enchant detection, and empty-socket detection are covered by Task 1 and Task 2.
- Raider.IO crawl freshness and safe `Needs verification` handling are covered by Tasks 2 and 3.
- Credentials, stale-age setup, health status, and user-facing docs are covered by Task 1.
- The plan contains no deferred implementation markers; 48 hours and the required enchant slots are explicit global settings.

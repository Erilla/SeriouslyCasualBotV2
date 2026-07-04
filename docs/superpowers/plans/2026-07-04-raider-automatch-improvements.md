# Raider Auto-Match Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make raider auto-match suggestions smarter — never re-suggest an already-linked user, match names through accents/realm-suffix/decoration, filter out bots, and add a single-candidate elimination short-circuit.

**Architecture:** All changes are localised to `src/functions/raids/autoMatchRaiders.ts` plus a new pure `normalizeName` helper. The suggestion UI, Confirm/Reject flow, and `raider_identity_map` persistence are unchanged — only *which* member (if any) gets suggested changes. `autoMatchRaiders` gains a read of the `raiders` and `config` tables.

**Tech Stack:** TypeScript (Node16 ESM), discord.js v14, better-sqlite3, vitest.

**Spec:** `docs/superpowers/specs/2026-07-04-raider-automatch-improvements-design.md`

## Global Constraints

- ESM with Node16 resolution: **all relative imports use the `.js` extension** (e.g. `./normalizeName.js`), even for `.ts` source.
- Tests live in `tests/unit/` and run with `npx vitest run <path>`.
- TDD: write the failing test first, watch it fail, implement, watch it pass, commit.
- **No new dependencies.**
- Commit messages: single-line conventional-commit subject; the repo's standard co-author/session trailer is appended per convention.
- `normalizeName` is used for **suggestion matching only** — do not wire it into `raider_identity_map` lookups or WarcraftLogs comparisons (both out of scope).

## File Structure

- **Create** `src/functions/raids/normalizeName.ts` — pure name-normalisation helper (one responsibility: turn a raw name into a comparable key).
- **Create** `tests/unit/normalizeName.test.ts` — unit tests for the helper.
- **Modify** `src/functions/raids/autoMatchRaiders.ts` — add DB reads, bot filtering, normalized matching, and the elimination short-circuit.
- **Modify** `tests/unit/autoMatchRaiders.test.ts` — add in-memory DB harness, richer member mocks, and new behaviour tests.

---

### Task 1: `normalizeName` helper

**Files:**
- Create: `src/functions/raids/normalizeName.ts`
- Test: `tests/unit/normalizeName.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export function normalizeName(name: string): string`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/normalizeName.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { normalizeName } from '../../src/functions/raids/normalizeName.js';

describe('normalizeName', () => {
  it('folds accents to ASCII', () => {
    expect(normalizeName('Hephaestüs')).toBe('hephaestus');
    expect(normalizeName('Renée')).toBe('renee');
  });

  it('drops the realm suffix (everything from the first hyphen)', () => {
    expect(normalizeName('Shadowleif-Silvermoon')).toBe('shadowleif');
  });

  it('strips punctuation, spaces, and emoji', () => {
    expect(normalizeName('✨Shadowleif✨')).toBe('shadowleif');
    expect(normalizeName('Shadow Leif')).toBe('shadowleif');
  });

  it('is case-insensitive', () => {
    expect(normalizeName('THRALL')).toBe('thrall');
  });

  it('equates a decorated Discord nick with the plain character name', () => {
    expect(normalizeName('✨Hephaestüs-Silvermoon✨')).toBe(normalizeName('Hephaestus'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/normalizeName.test.ts`
Expected: FAIL — cannot resolve `../../src/functions/raids/normalizeName.js` (module does not exist yet).

- [ ] **Step 3: Write the implementation**

Create `src/functions/raids/normalizeName.ts`:

```ts
/**
 * Normalise a name for fuzzy comparison between a WoW character name and a
 * Discord name. Applied symmetrically to BOTH sides before an equality check.
 *
 * Steps (order matters — accents must be folded before non-alphanumerics are
 * stripped, or accented letters would be discarded entirely):
 *   1. Drop the realm suffix: everything from the first '-'. WoW character
 *      names cannot contain '-'; Discord nicks sometimes carry "-Realm".
 *   2. Fold accents to ASCII: NFD-decompose then strip the combining-marks
 *      range U+0300–U+036F, so ü→u, é→e, ï→i, ñ→n.
 *   3. Lowercase.
 *   4. Strip everything outside [a-z0-9] (spaces, punctuation, emoji).
 */
export function normalizeName(name: string): string {
  return name
    .split('-')[0]
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/normalizeName.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/functions/raids/normalizeName.ts tests/unit/normalizeName.test.ts
git commit -m "feat(raids): add normalizeName helper for fuzzy name matching"
```

---

### Task 2: Name-match improvements — normalize, exclude already-linked, filter bots

**Files:**
- Modify: `src/functions/raids/autoMatchRaiders.ts`
- Test: `tests/unit/autoMatchRaiders.test.ts`

**Interfaces:**
- Consumes: `normalizeName(name: string): string` (Task 1); `getDatabase()` from `../../database/db.js`; `initDatabase(':memory:')`, `closeDatabase()` for tests.
- Produces: unchanged public signature `autoMatchRaiders(guild: Guild, unlinkedRaiders: RaiderRow[]): Promise<AutoMatch[]>` and `interface AutoMatch { raider: RaiderRow; suggestedUser: GuildMember }`. Now reads the `raiders` table (`discord_user_id`).

> Note: this task adds a `getDatabase()` call to `autoMatchRaiders`, so the test file must initialise an in-memory DB. Step 1 rewrites the test harness (mock members gain `user.bot` and `roles.cache`; a logger mock and DB helpers are added) and adds the new tests. Existing name-match tests keep working because the DB starts empty (no linked users, count 0).

- [ ] **Step 1: Rewrite the test file with the new harness and add failing tests**

Replace the entire contents of `tests/unit/autoMatchRaiders.test.ts` with:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Guild, GuildMember, User } from 'discord.js';
import { initDatabase, closeDatabase, getDatabase } from '../../src/database/db.js';
import type { RaiderRow } from '../../src/types/index.js';

vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { autoMatchRaiders } from '../../src/functions/raids/autoMatchRaiders.js';
import { logger } from '../../src/services/logger.js';

function createMockMember(
  displayName: string,
  globalDisplayName: string,
  username: string,
  id = '123456789',
  opts: { bot?: boolean; roleIds?: string[] } = {},
): GuildMember {
  const roleIds = new Set(opts.roleIds ?? []);
  return {
    displayName,
    id,
    user: {
      displayName: globalDisplayName,
      username,
      id,
      bot: opts.bot ?? false,
    } as User,
    roles: { cache: { has: (roleId: string) => roleIds.has(roleId) } },
  } as unknown as GuildMember;
}

function createMockGuild(members: GuildMember[]): Guild {
  const membersMap = new Map(members.map((m, i) => [String(i), m]));
  return {
    members: {
      fetch: vi.fn().mockResolvedValue(membersMap),
    },
  } as unknown as Guild;
}

function createRaider(characterName: string): RaiderRow {
  return {
    id: 1,
    character_name: characterName,
    realm: 'silvermoon',
    region: 'eu',
    rank: null,
    class: null,
    discord_user_id: null,
    message_id: null,
    missing_since: null,
  };
}

function insertRaider(name: string, discordUserId: string | null = null) {
  getDatabase()
    .prepare('INSERT INTO raiders (character_name, discord_user_id) VALUES (?, ?)')
    .run(name, discordUserId);
}

function setRaiderRole(roleId: string) {
  getDatabase()
    .prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)')
    .run('raider_role_id', roleId);
}

beforeEach(() => {
  closeDatabase();
  initDatabase(':memory:');
  vi.clearAllMocks();
});

afterEach(() => {
  closeDatabase();
});

describe('autoMatchRaiders', () => {
  it('should match on exact displayName', async () => {
    const member = createMockMember('Thrall', 'SomeGlobal', 'someuser');
    const guild = createMockGuild([member]);
    const raider = createRaider('Thrall');

    const result = await autoMatchRaiders(guild, [raider]);

    expect(result).toHaveLength(1);
    expect(result[0].raider.character_name).toBe('Thrall');
    expect(result[0].suggestedUser).toBe(member);
  });

  it('should match case-insensitively', async () => {
    const member = createMockMember('THRALL', 'SomeGlobal', 'someuser');
    const guild = createMockGuild([member]);
    const raider = createRaider('thrall');

    const result = await autoMatchRaiders(guild, [raider]);

    expect(result).toHaveLength(1);
    expect(result[0].suggestedUser).toBe(member);
  });

  it('should return empty when no match found', async () => {
    const member = createMockMember('Jaina', 'JainaGlobal', 'jainauser');
    const guild = createMockGuild([member]);
    const raider = createRaider('Thrall');

    const result = await autoMatchRaiders(guild, [raider]);

    expect(result).toHaveLength(0);
  });

  it('should skip ambiguous matches (multiple members match same name)', async () => {
    const member1 = createMockMember('Thrall', 'SomeGlobal1', 'user1', '111');
    const member2 = createMockMember('Thrall', 'SomeGlobal2', 'user2', '222');
    const guild = createMockGuild([member1, member2]);
    const raider = createRaider('Thrall');

    const result = await autoMatchRaiders(guild, [raider]);

    expect(result).toHaveLength(0);
  });

  it('should return empty for empty unlinked raiders array', async () => {
    const guild = createMockGuild([]);

    const result = await autoMatchRaiders(guild, []);

    expect(result).toHaveLength(0);
  });

  it('should match on user.displayName (global display name)', async () => {
    const member = createMockMember('ServerNick', 'Thrall', 'someuser');
    const guild = createMockGuild([member]);
    const raider = createRaider('Thrall');

    const result = await autoMatchRaiders(guild, [raider]);

    expect(result).toHaveLength(1);
    expect(result[0].suggestedUser).toBe(member);
  });

  it('should match on user.username', async () => {
    const member = createMockMember('ServerNick', 'SomeGlobal', 'thrall');
    const guild = createMockGuild([member]);
    const raider = createRaider('Thrall');

    const result = await autoMatchRaiders(guild, [raider]);

    expect(result).toHaveLength(1);
    expect(result[0].suggestedUser).toBe(member);
  });

  // ── New behaviour ──────────────────────────────────────────

  it('excludes a Discord user already linked to another raider', async () => {
    const member = createMockMember('Thrall', 'g', 'u', '999');
    const guild = createMockGuild([member]);
    insertRaider('Grommash', '999'); // user 999 already linked elsewhere
    const raider = createRaider('Thrall'); // name matches member 999

    const result = await autoMatchRaiders(guild, [raider]);

    expect(result).toHaveLength(0);
  });

  it('suggests the only non-already-linked name match', async () => {
    const linked = createMockMember('Thrall', 'g1', 'u1', '111');
    const free = createMockMember('Thrall', 'g2', 'u2', '222');
    const guild = createMockGuild([linked, free]);
    insertRaider('Grommash', '111'); // 111 already linked
    const raider = createRaider('Thrall');

    const result = await autoMatchRaiders(guild, [raider]);

    expect(result).toHaveLength(1);
    expect(result[0].suggestedUser.id).toBe('222');
  });

  it('never suggests a bot even on a name match', async () => {
    const bot = createMockMember('Thrall', 'g', 'u', '777', { bot: true });
    const guild = createMockGuild([bot]);
    const raider = createRaider('Thrall');

    const result = await autoMatchRaiders(guild, [raider]);

    expect(result).toHaveLength(0);
  });

  it('matches through accents, realm suffix, and decoration', async () => {
    const member = createMockMember('✨Hephaestüs-Silvermoon✨', 'g', 'u', '555');
    const guild = createMockGuild([member]);
    const raider = createRaider('Hephaestus');

    const result = await autoMatchRaiders(guild, [raider]);

    expect(result).toHaveLength(1);
    expect(result[0].suggestedUser.id).toBe('555');
  });
});
```

- [ ] **Step 2: Run the tests to verify the NEW ones fail**

Run: `npx vitest run tests/unit/autoMatchRaiders.test.ts`
Expected: the four new tests FAIL (current code doesn't exclude linked users, doesn't filter bots, and matches only on exact/lowercase equality — e.g. `excludes a Discord user already linked` returns length 1, `matches through accents…` returns length 0). The seven original tests PASS.

- [ ] **Step 3: Rewrite `autoMatchRaiders` implementation**

Replace the entire contents of `src/functions/raids/autoMatchRaiders.ts` with:

```ts
import type { Guild, GuildMember } from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';
import { normalizeName } from './normalizeName.js';
import type { RaiderRow } from '../../types/index.js';

export interface AutoMatch {
  raider: RaiderRow;
  suggestedUser: GuildMember;
}

export async function autoMatchRaiders(
  guild: Guild,
  unlinkedRaiders: RaiderRow[],
): Promise<AutoMatch[]> {
  if (unlinkedRaiders.length === 0) return [];

  const db = getDatabase();

  // Discord users already linked to some raider — never suggest them again.
  const linkedRows = db
    .prepare('SELECT discord_user_id FROM raiders WHERE discord_user_id IS NOT NULL')
    .all() as { discord_user_id: string }[];
  const linkedUserIds = new Set(linkedRows.map((r) => r.discord_user_id));

  let members;
  try {
    members = await guild.members.fetch();
  } catch (error) {
    logger.error('AutoMatch', 'Failed to fetch guild members', error as Error);
    return [];
  }

  const matches: AutoMatch[] = [];

  for (const raider of unlinkedRaiders) {
    const normalizedCharName = normalizeName(raider.character_name);
    const matchingMembers: GuildMember[] = [];

    for (const [, member] of members) {
      if (member.user.bot) continue;
      if (linkedUserIds.has(member.id)) continue;

      if (
        normalizeName(member.displayName) === normalizedCharName ||
        normalizeName(member.user.displayName) === normalizedCharName ||
        normalizeName(member.user.username) === normalizedCharName
      ) {
        matchingMembers.push(member);
      }
    }

    if (matchingMembers.length === 1) {
      matches.push({ raider, suggestedUser: matchingMembers[0] });
    } else if (matchingMembers.length > 1) {
      logger.debug(
        'AutoMatch',
        `Ambiguous match for "${raider.character_name}": ${matchingMembers.length} members matched, skipping`,
      );
    }
  }

  logger.info(
    'AutoMatch',
    `Found ${matches.length} auto-matches out of ${unlinkedRaiders.length} unlinked raiders`,
  );
  return matches;
}
```

- [ ] **Step 4: Run the tests to verify all pass**

Run: `npx vitest run tests/unit/autoMatchRaiders.test.ts`
Expected: PASS (all 11 tests).

- [ ] **Step 5: Commit**

```bash
git add src/functions/raids/autoMatchRaiders.ts tests/unit/autoMatchRaiders.test.ts
git commit -m "feat(raids): normalize names, exclude already-linked users and bots in auto-match"
```

---

### Task 3: Elimination short-circuit

**Files:**
- Modify: `src/functions/raids/autoMatchRaiders.ts`
- Test: `tests/unit/autoMatchRaiders.test.ts`

**Interfaces:**
- Consumes: `ConfigRow` from `../../types/index.js`; the `insertRaider`/`setRaiderRole` test helpers and `logger` mock added in Task 2.
- Produces: same public signature; now also reads `COUNT(*)` of unlinked raiders and the `raider_role_id` config value.

- [ ] **Step 1: Add the failing elimination tests**

Append these tests inside the `describe('autoMatchRaiders', …)` block in `tests/unit/autoMatchRaiders.test.ts` (before its closing `});`):

```ts
  it('elimination: sole unlinked raider + sole unlinked Raider-role member is suggested', async () => {
    const roleId = 'raider-role';
    const member = createMockMember('SomeoneElse', 'g', 'u', '333', { roleIds: [roleId] });
    const guild = createMockGuild([member]);
    setRaiderRole(roleId);
    insertRaider('Shadowleif', null); // the sole unlinked raider in the DB
    const raider = createRaider('Shadowleif'); // name does NOT match 'SomeoneElse'

    const result = await autoMatchRaiders(guild, [raider]);

    expect(result).toHaveLength(1);
    expect(result[0].suggestedUser.id).toBe('333');
    expect(logger.info).toHaveBeenCalledWith(
      'AutoMatch',
      expect.stringContaining('elimination match'),
    );
  });

  it('elimination suppressed when more than one unlinked raider exists', async () => {
    const roleId = 'raider-role';
    const member = createMockMember('SomeoneElse', 'g', 'u', '333', { roleIds: [roleId] });
    const guild = createMockGuild([member]);
    setRaiderRole(roleId);
    insertRaider('Shadowleif', null);
    insertRaider('Otherguy', null); // now 2 unlinked raiders
    const raider = createRaider('Shadowleif');

    const result = await autoMatchRaiders(guild, [raider]);

    expect(result).toHaveLength(0);
  });

  it('elimination suppressed when more than one unlinked Raider-role member exists', async () => {
    const roleId = 'raider-role';
    const m1 = createMockMember('A', 'g', 'u', '333', { roleIds: [roleId] });
    const m2 = createMockMember('B', 'g', 'u', '444', { roleIds: [roleId] });
    const guild = createMockGuild([m1, m2]);
    setRaiderRole(roleId);
    insertRaider('Shadowleif', null);
    const raider = createRaider('Shadowleif');

    const result = await autoMatchRaiders(guild, [raider]);

    expect(result).toHaveLength(0);
  });

  it('elimination suppressed when raider_role_id is not configured', async () => {
    const member = createMockMember('SomeoneElse', 'g', 'u', '333', { roleIds: ['raider-role'] });
    const guild = createMockGuild([member]);
    insertRaider('Shadowleif', null); // 1 unlinked, but no role configured
    const raider = createRaider('Shadowleif');

    const result = await autoMatchRaiders(guild, [raider]);

    expect(result).toHaveLength(0);
  });

  it('elimination does not count a bot toward the eligible member', async () => {
    const roleId = 'raider-role';
    const human = createMockMember('SomeoneElse', 'g', 'u', '333', { roleIds: [roleId] });
    const bot = createMockMember('BotUser', 'g', 'u', '888', { roleIds: [roleId], bot: true });
    const guild = createMockGuild([human, bot]);
    setRaiderRole(roleId);
    insertRaider('Shadowleif', null);
    const raider = createRaider('Shadowleif');

    const result = await autoMatchRaiders(guild, [raider]);

    expect(result).toHaveLength(1);
    expect(result[0].suggestedUser.id).toBe('333');
  });
```

- [ ] **Step 2: Run the tests to verify the elimination tests fail**

Run: `npx vitest run tests/unit/autoMatchRaiders.test.ts`
Expected: `elimination: sole unlinked raider …` and `elimination does not count a bot …` FAIL (current code has no elimination path, so they return length 0 / no `elimination match` log). The three "suppressed" tests already PASS (they correctly return 0), and the 11 Task-2 tests PASS.

- [ ] **Step 3: Add the elimination short-circuit to the implementation**

Replace the entire contents of `src/functions/raids/autoMatchRaiders.ts` with the final version (name-match block unchanged; adds the `ConfigRow` import, two DB reads, and the short-circuit block before name matching):

```ts
import type { Guild, GuildMember } from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';
import { normalizeName } from './normalizeName.js';
import type { RaiderRow, ConfigRow } from '../../types/index.js';

export interface AutoMatch {
  raider: RaiderRow;
  suggestedUser: GuildMember;
}

export async function autoMatchRaiders(
  guild: Guild,
  unlinkedRaiders: RaiderRow[],
): Promise<AutoMatch[]> {
  if (unlinkedRaiders.length === 0) return [];

  const db = getDatabase();

  // Discord users already linked to some raider — never suggest them again.
  const linkedRows = db
    .prepare('SELECT discord_user_id FROM raiders WHERE discord_user_id IS NOT NULL')
    .all() as { discord_user_id: string }[];
  const linkedUserIds = new Set(linkedRows.map((r) => r.discord_user_id));

  const totalUnlinkedCount = (
    db
      .prepare('SELECT COUNT(*) AS n FROM raiders WHERE discord_user_id IS NULL')
      .get() as { n: number }
  ).n;

  const raiderRoleId =
    (
      db
        .prepare('SELECT value FROM config WHERE key = ?')
        .get('raider_role_id') as ConfigRow | undefined
    )?.value ?? null;

  let members;
  try {
    members = await guild.members.fetch();
  } catch (error) {
    logger.error('AutoMatch', 'Failed to fetch guild members', error as Error);
    return [];
  }

  // Elimination short-circuit: when there is exactly one unlinked raider and
  // exactly one unlinked Raider-role member, suggest that pairing directly and
  // skip name matching. Requires raider_role_id to be configured.
  if (totalUnlinkedCount === 1 && raiderRoleId) {
    const eligible: GuildMember[] = [];
    for (const [, member] of members) {
      if (member.user.bot) continue;
      if (linkedUserIds.has(member.id)) continue;
      if (member.roles.cache.has(raiderRoleId)) {
        eligible.push(member);
      }
    }

    if (eligible.length === 1) {
      const raider = unlinkedRaiders[0];
      logger.info(
        'AutoMatch',
        `elimination match: ${raider.character_name} -> @${eligible[0].id} ` +
          `(sole unlinked raider + sole unlinked Raider-role member)`,
      );
      return [{ raider, suggestedUser: eligible[0] }];
    }
  }

  const matches: AutoMatch[] = [];

  for (const raider of unlinkedRaiders) {
    const normalizedCharName = normalizeName(raider.character_name);
    const matchingMembers: GuildMember[] = [];

    for (const [, member] of members) {
      if (member.user.bot) continue;
      if (linkedUserIds.has(member.id)) continue;

      if (
        normalizeName(member.displayName) === normalizedCharName ||
        normalizeName(member.user.displayName) === normalizedCharName ||
        normalizeName(member.user.username) === normalizedCharName
      ) {
        matchingMembers.push(member);
      }
    }

    if (matchingMembers.length === 1) {
      matches.push({ raider, suggestedUser: matchingMembers[0] });
    } else if (matchingMembers.length > 1) {
      logger.debug(
        'AutoMatch',
        `Ambiguous match for "${raider.character_name}": ${matchingMembers.length} members matched, skipping`,
      );
    }
  }

  logger.info(
    'AutoMatch',
    `Found ${matches.length} auto-matches out of ${unlinkedRaiders.length} unlinked raiders`,
  );
  return matches;
}
```

- [ ] **Step 4: Run the tests to verify all pass**

Run: `npx vitest run tests/unit/autoMatchRaiders.test.ts`
Expected: PASS (all 16 tests).

- [ ] **Step 5: Typecheck and run the full unit suite**

Run: `npx tsc --noEmit`
Expected: exit 0, no output.

Run: `npx vitest run tests/unit`
Expected: all unit tests pass (no regressions). e2e test files that require `.env.test` are expected to fail to bootstrap and are unrelated.

- [ ] **Step 6: Commit**

```bash
git add src/functions/raids/autoMatchRaiders.ts tests/unit/autoMatchRaiders.test.ts
git commit -m "feat(raids): add single-candidate elimination short-circuit to auto-match"
```

---

## Self-Review

**Spec coverage:**
- Change 1 (exclude already-linked) → Task 2 (`linkedUserIds` filter) ✓
- Change 2 (elimination short-circuit, all-unlinked-in-DB scope, elimination-first) → Task 3 ✓
- Filter out bots → Task 2 (name match) + Task 3 (eligible pool) ✓
- Log elimination reason → Task 3 (`logger.info('AutoMatch', 'elimination match: …')`) ✓
- `normalizeName` (realm strip → accent fold → lowercase → strip non-alnum) → Task 1 ✓
- `raider_role_id` unset → skip elimination → Task 3 test + guard ✓
- Testing bullets from spec → covered across Tasks 1–3 ✓
- Out of scope (WCL, identity-map) → untouched ✓

**Placeholder scan:** none — every step has concrete code and commands.

**Type consistency:** `normalizeName(name: string): string` used identically in Tasks 1–3; `AutoMatch`/`RaiderRow`/`ConfigRow` names match `src/types/index.ts`; `raider_role_id` config key matches `assignRaiderRole.ts`; member mock shape (`user.bot`, `roles.cache.has`) matches the implementation's access.

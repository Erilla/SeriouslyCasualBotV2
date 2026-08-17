# Trials as Roster Members Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every active trial a `raiders` row that the Raider.IO roster sync will not hide, so trials are pinged and listed like any other raider.

**Architecture:** One idempotent module (`ensureTrialRaiders.ts`) owns the insert path. `syncRaiders` calls it, exempts active trials from the missing/inactive stamping, and refreshes roster-owned columns from the API. `acceptApplication` calls the same function so the row appears within seconds rather than at the next ten-minute sync.

**Tech Stack:** TypeScript (ESM, Node16 module resolution), better-sqlite3 (synchronous), discord.js v14, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-17-trials-as-roster-members-design.md`

## Global Constraints

- Spec is authoritative. Read it before Task 1.
- Case-insensitive character matching everywhere, via SQL `COLLATE NOCASE` — consistent with `linkCharacterIdentity` (`src/functions/raids/linkCharacterIdentity.ts:21`).
- A character in `ignored_characters` is never inserted or resurrected.
- An existing non-null `raiders.discord_user_id` is never overwritten. A null one may be filled.
- `raiders.rank` and `raiders.class` are left NULL on a synthesised insert; the refresh rule fills them when the character reaches the Raider.IO roster.
- Default realm/region for a synthesised row: `silvermoon` / `eu`.
- Imports use `.js` extensions (ESM). Type-only imports use `import type`.
- Every task ends green on `npx tsc --noEmit`, `npx eslint <changed files>`, `npx prettier --check <changed files>` and `npm test`. A prettier failure blocks the Railway deploy, so never skip it.
- Do **not** push. Commits stay local; pushing `main` restarts the test bot.

---

### Task 0: Commit the signup-mention fix already in the working tree

The root-cause fix for the reported bug is already written, tested and green, but uncommitted. It ships independently of the rest of this plan. Commit it first so later tasks have a clean tree.

**Files:**

- Commit (already written): `src/functions/raids/resolveSignupMentions.ts`, `src/functions/raids/alertSignups.ts`, `tests/unit/resolveSignupMentions.test.ts`

- [ ] **Step 1: Confirm the tree holds exactly those three files**

Run: `git status --short`
Expected: `?? src/functions/raids/resolveSignupMentions.ts`, `?? tests/unit/resolveSignupMentions.test.ts`, `M src/functions/raids/alertSignups.ts`. If anything else is modified, stop and ask.

- [ ] **Step 2: Verify green before committing**

Run: `npx tsc --noEmit && npx vitest run tests/unit/resolveSignupMentions.test.ts`
Expected: no type errors; 11 tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/functions/raids/resolveSignupMentions.ts src/functions/raids/alertSignups.ts tests/unit/resolveSignupMentions.test.ts
git commit -F - <<'EOF'
fix(raids): ping new trials the roster table does not know yet

The signup reminder resolved mentions from `raiders` alone, so a brand-new
trial was named as plain text next to everyone else's ping. `raiders` comes
from the Raider.IO roster filtered to ROSTER_RANKS, and a new trial fails that
gate two ways: a fresh guild invite sits at rank 8, and Raider.IO does not list
a character it has not crawled.

Their Discord account is known regardless -- from the officer's pick on the
trial record, or from the application identity map -- so fall back to those
before printing a bare name. Roster link first, then active trial, then the
self-asserted application link; inactive raiders and closed trials cannot
out-rank a live row.

Also stops lowercasing the signup names, so the fallback reads **Etav**.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 1: The `ensureTrialRaiders` module

**Files:**

- Create: `src/functions/raids/ensureTrialRaiders.ts`
- Test: `tests/unit/ensureTrialRaiders.test.ts`

**Interfaces:**

- Consumes: `RaiderRow` and `TrialRow` from `src/types/index.js`; `logger` from `src/services/logger.js`.
- Produces:
  - `DEFAULT_REALM = 'silvermoon'`, `DEFAULT_REGION = 'eu'`
  - `type EnsureResult = 'inserted' | 'linked' | 'exists' | 'ignored'`
  - `type EnsurableTrial = Pick<TrialRow, 'character_name' | 'discord_user_id' | 'application_id'>`
  - `trialRealm(db: Database, trial: Pick<TrialRow, 'application_id'>): { realm: string; region: string }`
  - `ensureRaiderForTrial(db: Database, trial: EnsurableTrial): EnsureResult`
  - `ensureRaidersForActiveTrials(db: Database): RaiderRow[]` — returns only freshly inserted rows with no Discord link
  - `Database` is the default-export type of `better-sqlite3`, imported as `import type { Database } from 'better-sqlite3';` (matches `src/functions/raids/resolveSignupMentions.ts`).

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/ensureTrialRaiders.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../src/database/db.js';
import type { RaiderRow } from '../../src/types/index.js';

vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  ensureRaiderForTrial,
  ensureRaidersForActiveTrials,
  trialRealm,
  DEFAULT_REALM,
  DEFAULT_REGION,
} from '../../src/functions/raids/ensureTrialRaiders.js';

function addTrial(
  name: string,
  discordUserId: string | null,
  status = 'active',
  applicationId: number | null = null,
) {
  getDatabase()
    .prepare(
      `INSERT INTO trials (character_name, role, start_date, status, discord_user_id, application_id)
       VALUES (?, 'DPS', '2026-08-18', ?, ?, ?)`,
    )
    .run(name, status, discordUserId, applicationId);
}

function addRaider(name: string, discordUserId: string | null) {
  getDatabase()
    .prepare('INSERT INTO raiders (character_name, discord_user_id) VALUES (?, ?)')
    .run(name, discordUserId);
}

function addIntelJob(applicationId: number, realm: string, region: string) {
  getDatabase()
    .prepare(
      `INSERT INTO applicant_intel_jobs (application_id, character_name, character_realm, character_region)
       VALUES (?, 'Whoever', ?, ?)`,
    )
    .run(applicationId, realm, region);
}

function raider(name: string): RaiderRow | undefined {
  return getDatabase()
    .prepare('SELECT * FROM raiders WHERE character_name = ? COLLATE NOCASE')
    .get(name) as RaiderRow | undefined;
}

const trialOf = (
  name: string,
  discordUserId: string | null,
  applicationId: number | null = null,
) => ({
  character_name: name,
  discord_user_id: discordUserId,
  application_id: applicationId,
});

describe('ensureRaiderForTrial', () => {
  beforeEach(() => {
    closeDatabase();
    initDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
  });

  it('inserts a linked row for a trial with no raiders row', () => {
    expect(ensureRaiderForTrial(getDatabase(), trialOf('Neralia', '222'))).toBe('inserted');

    const row = raider('Neralia');
    expect(row?.discord_user_id).toBe('222');
    expect(row?.realm).toBe(DEFAULT_REALM);
    expect(row?.region).toBe(DEFAULT_REGION);
    expect(row?.rank).toBeNull();
    expect(row?.class).toBeNull();
  });

  it('is idempotent: a second call reports exists and does not duplicate', () => {
    ensureRaiderForTrial(getDatabase(), trialOf('Neralia', '222'));

    expect(ensureRaiderForTrial(getDatabase(), trialOf('Neralia', '222'))).toBe('exists');
    const count = getDatabase()
      .prepare('SELECT COUNT(*) AS n FROM raiders WHERE character_name = ? COLLATE NOCASE')
      .get('Neralia') as { n: number };
    expect(count.n).toBe(1);
  });

  it('matches an existing row case-insensitively', () => {
    addRaider('Neralia', '222');

    expect(ensureRaiderForTrial(getDatabase(), trialOf('neralia', '222'))).toBe('exists');
  });

  it('fills a null discord_user_id from the trial', () => {
    addRaider('Neralia', null);

    expect(ensureRaiderForTrial(getDatabase(), trialOf('Neralia', '222'))).toBe('linked');
    expect(raider('Neralia')?.discord_user_id).toBe('222');
  });

  it('never overwrites an existing discord_user_id', () => {
    addRaider('Neralia', '111');

    expect(ensureRaiderForTrial(getDatabase(), trialOf('Neralia', '222'))).toBe('exists');
    expect(raider('Neralia')?.discord_user_id).toBe('111');
  });

  it('leaves an unlinked row unlinked when the trial has no Discord user either', () => {
    addRaider('Neralia', null);

    expect(ensureRaiderForTrial(getDatabase(), trialOf('Neralia', null))).toBe('exists');
    expect(raider('Neralia')?.discord_user_id).toBeNull();
  });

  it('refuses to insert an ignored character', () => {
    getDatabase()
      .prepare('INSERT INTO ignored_characters (character_name) VALUES (?)')
      .run('Neralia');

    expect(ensureRaiderForTrial(getDatabase(), trialOf('neralia', '222'))).toBe('ignored');
    expect(raider('Neralia')).toBeUndefined();
  });

  it('takes realm and region from the applicant intel job when there is one', () => {
    addIntelJob(7, 'draenor', 'eu');

    ensureRaiderForTrial(getDatabase(), trialOf('Jovaz', '111', 7));

    expect(raider('Jovaz')?.realm).toBe('draenor');
    expect(raider('Jovaz')?.region).toBe('eu');
  });
});

describe('trialRealm', () => {
  beforeEach(() => {
    closeDatabase();
    initDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
  });

  it('defaults when the trial has no application', () => {
    expect(trialRealm(getDatabase(), { application_id: null })).toEqual({
      realm: DEFAULT_REALM,
      region: DEFAULT_REGION,
    });
  });

  it('defaults when the application ran no intel job', () => {
    expect(trialRealm(getDatabase(), { application_id: 7 })).toEqual({
      realm: DEFAULT_REALM,
      region: DEFAULT_REGION,
    });
  });

  it('uses the newest intel job for the application', () => {
    addIntelJob(7, 'silvermoon', 'eu');
    addIntelJob(7, 'draenor', 'eu');

    expect(trialRealm(getDatabase(), { application_id: 7 })).toEqual({
      realm: 'draenor',
      region: 'eu',
    });
  });
});

describe('ensureRaidersForActiveTrials', () => {
  beforeEach(() => {
    closeDatabase();
    initDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
  });

  it('inserts rows for active trials only', () => {
    addTrial('Etav', '333');
    addTrial('Oldtrial', '444', 'closed');
    addTrial('Promoted', '555', 'promoted');

    ensureRaidersForActiveTrials(getDatabase());

    expect(raider('Etav')).toBeDefined();
    expect(raider('Oldtrial')).toBeUndefined();
    expect(raider('Promoted')).toBeUndefined();
  });

  it('returns freshly inserted rows that have no Discord link', () => {
    addTrial('Unlinked', null);
    addTrial('Linked', '333');

    const inserted = ensureRaidersForActiveTrials(getDatabase());

    expect(inserted.map((r) => r.character_name)).toEqual(['Unlinked']);
    expect(inserted[0].id).toBeGreaterThan(0);
  });

  it('returns nothing on a second run, so the sync cannot re-alert', () => {
    addTrial('Unlinked', null);
    ensureRaidersForActiveTrials(getDatabase());

    expect(ensureRaidersForActiveTrials(getDatabase())).toEqual([]);
  });

  it('tolerates two active trials for the same character', () => {
    addTrial('Etav', '333');
    addTrial('Etav', '333');

    expect(() => ensureRaidersForActiveTrials(getDatabase())).not.toThrow();
    const count = getDatabase().prepare('SELECT COUNT(*) AS n FROM raiders').get() as { n: number };
    expect(count.n).toBe(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/ensureTrialRaiders.test.ts`
Expected: FAIL — cannot resolve `src/functions/raids/ensureTrialRaiders.js`.

- [ ] **Step 3: Write the implementation**

Create `src/functions/raids/ensureTrialRaiders.ts`:

```typescript
import type { Database } from 'better-sqlite3';
import { logger } from '../../services/logger.js';
import type { RaiderRow, TrialRow } from '../../types/index.js';

/** Our own guild's realm and region, used when nothing better is known. */
export const DEFAULT_REALM = 'silvermoon';
export const DEFAULT_REGION = 'eu';

export type EnsureResult = 'inserted' | 'linked' | 'exists' | 'ignored';

export type EnsurableTrial = Pick<
  TrialRow,
  'character_name' | 'discord_user_id' | 'application_id'
>;

/**
 * Best-known realm and region for a trial's character.
 *
 * `trials` stores no realm, so the only record of one is the applicant intel job
 * that ran for the application. Newest job wins: a re-run corrects an earlier
 * misparse. Falls back to our own guild's realm, which is right for most trials
 * and is corrected by syncRaiders once Raider.IO lists the character.
 */
export function trialRealm(
  db: Database,
  trial: Pick<TrialRow, 'application_id'>,
): { realm: string; region: string } {
  if (trial.application_id === null) {
    return { realm: DEFAULT_REALM, region: DEFAULT_REGION };
  }

  const job = db
    .prepare(
      `SELECT character_realm, character_region FROM applicant_intel_jobs
        WHERE application_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(trial.application_id) as { character_realm: string; character_region: string } | undefined;

  return job
    ? { realm: job.character_realm, region: job.character_region }
    : { realm: DEFAULT_REALM, region: DEFAULT_REGION };
}

/**
 * Give a trial a `raiders` row, because a trial is a roster member.
 *
 * The roster sync cannot do this on its own: it reads the Raider.IO guild roster
 * filtered to ROSTER_RANKS, and a new trial fails that gate both ways — a fresh
 * guild invite sits at rank 8, and Raider.IO does not list a character it has
 * not crawled. Without a row the trial is invisible to every roster consumer,
 * including the signup ping.
 *
 * Idempotent, so both callers (acceptApplication and syncRaiders) can run it
 * freely. Two rows are never created for one character, an ignored character is
 * never resurrected, and an existing Discord link is never overwritten — though
 * a null one is filled, which is the only way an already-inserted unlinked row
 * ever picks up the link the trial record knows about.
 */
export function ensureRaiderForTrial(db: Database, trial: EnsurableTrial): EnsureResult {
  const ignored = db
    .prepare('SELECT 1 FROM ignored_characters WHERE character_name = ? COLLATE NOCASE')
    .get(trial.character_name);

  if (ignored) {
    logger.debug(
      'EnsureTrialRaiders',
      `Trial "${trial.character_name}" is an ignored character; no roster row`,
    );
    return 'ignored';
  }

  const existing = db
    .prepare('SELECT * FROM raiders WHERE character_name = ? COLLATE NOCASE')
    .get(trial.character_name) as RaiderRow | undefined;

  if (existing) {
    if (existing.discord_user_id !== null || trial.discord_user_id === null) return 'exists';

    // Clearing message_id retires any linking post for this raider: the
    // raider-setup refresh sweeps every message it no longer wants to keep.
    db.prepare('UPDATE raiders SET discord_user_id = ?, message_id = NULL WHERE id = ?').run(
      trial.discord_user_id,
      existing.id,
    );
    logger.info(
      'EnsureTrialRaiders',
      `Linked existing roster row for trial "${trial.character_name}" to ${trial.discord_user_id}`,
    );
    return 'linked';
  }

  const { realm, region } = trialRealm(db, trial);

  db.prepare(
    `INSERT INTO raiders (character_name, realm, region, rank, class, discord_user_id)
     VALUES (?, ?, ?, NULL, NULL, ?)`,
  ).run(trial.character_name, realm, region, trial.discord_user_id);

  logger.info(
    'EnsureTrialRaiders',
    `Added trial "${trial.character_name}" (${realm}-${region}) to the roster`,
  );
  return 'inserted';
}

/**
 * Ensure a roster row for every active trial.
 *
 * Returns only the rows this call inserted that have no Discord link, which is
 * what syncRaiders feeds to auto-match and the linking message. Rows that
 * already existed are excluded so the ten-minute sync never re-alerts the same
 * raider.
 */
export function ensureRaidersForActiveTrials(db: Database): RaiderRow[] {
  const trials = db
    .prepare(
      `SELECT character_name, discord_user_id, application_id FROM trials
        WHERE status = 'active'`,
    )
    .all() as EnsurableTrial[];

  const insertedUnlinked: RaiderRow[] = [];

  for (const trial of trials) {
    if (ensureRaiderForTrial(db, trial) !== 'inserted') continue;
    if (trial.discord_user_id !== null) continue;

    const row = db
      .prepare('SELECT * FROM raiders WHERE character_name = ? COLLATE NOCASE')
      .get(trial.character_name) as RaiderRow;
    insertedUnlinked.push(row);
  }

  return insertedUnlinked;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/ensureTrialRaiders.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Verify the checks**

Run: `npx tsc --noEmit && npx eslint src/functions/raids/ensureTrialRaiders.ts tests/unit/ensureTrialRaiders.test.ts && npx prettier --check src/functions/raids/ensureTrialRaiders.ts tests/unit/ensureTrialRaiders.test.ts`
Expected: all clean. If prettier complains, run it with `--write` and re-run the tests.

- [ ] **Step 6: Commit**

```bash
git add src/functions/raids/ensureTrialRaiders.ts tests/unit/ensureTrialRaiders.test.ts
git commit -F - <<'EOF'
feat(raids): idempotent roster row for an active trial

A trial is a roster member, but syncRaiders cannot see one: it reads the
Raider.IO roster filtered to ROSTER_RANKS, and a new trial is either at rank 8
(a fresh guild invite) or uncrawled and absent entirely.

One insert path, safe to call from anywhere: never duplicates, never
resurrects an ignored character, never overwrites a Discord link -- but does
fill a null one, which is how an already-inserted unlinked row finally picks up
what the trial record knew. Realm comes from the applicant intel job when one
ran, else our own guild's.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 2: Exempt active trials from missing/inactive stamping

Without this, a row inserted by Task 1 is stamped `missing_since` on the next sync and hidden 24 hours later — every consumer filters on `inactive_since IS NULL`.

**Files:**

- Modify: `src/functions/raids/syncRaiders.ts` (the absence pass, currently lines 49-78)
- Test: `tests/integration/raids-flow.test.ts`

**Interfaces:**

- Consumes: nothing from Task 1.
- Produces: no new exports. `syncRaiders(client)` keeps its signature `(client: Client) => Promise<RaiderRow[]>`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/integration/raids-flow.test.ts`, inside the existing top-level `describe`. The file already provides `makeMember`, `mockClient`, `mockedGetGuildRoster` and a `beforeEach` that runs `initDatabase(':memory:')` — use them; do not redefine them.

```typescript
function addTrial(name: string, status = 'active', discordUserId: string | null = '999') {
  getDatabase()
    .prepare(
      `INSERT INTO trials (character_name, role, start_date, status, discord_user_id)
         VALUES (?, 'DPS', '2026-08-18', ?, ?)`,
    )
    .run(name, status, discordUserId);
}

it('does not mark an active trial missing when Raider.IO has not crawled them', async () => {
  const db = getDatabase();
  db.prepare('INSERT INTO raiders (character_name, discord_user_id) VALUES (?, ?)').run(
    'Etav',
    '999',
  );
  addTrial('Etav');
  mockedGetGuildRoster.mockResolvedValue([]);

  await syncRaiders(mockClient);

  const row = db.prepare('SELECT * FROM raiders WHERE character_name = ?').get('Etav') as {
    missing_since: string | null;
  };
  expect(row.missing_since).toBeNull();
});

it('clears a stamp a previous sync left on an active trial', async () => {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO raiders (character_name, discord_user_id, missing_since, inactive_since)
       VALUES (?, ?, ?, ?)`,
  ).run('Etav', '999', '2026-08-01T00:00:00Z', '2026-08-02T00:00:00Z');
  addTrial('Etav');
  mockedGetGuildRoster.mockResolvedValue([]);

  await syncRaiders(mockClient);

  const row = db.prepare('SELECT * FROM raiders WHERE character_name = ?').get('Etav') as {
    missing_since: string | null;
    inactive_since: string | null;
  };
  expect(row.missing_since).toBeNull();
  expect(row.inactive_since).toBeNull();
});

it('still marks a closed trial missing', async () => {
  const db = getDatabase();
  db.prepare('INSERT INTO raiders (character_name, discord_user_id) VALUES (?, ?)').run(
    'Oldtrial',
    '999',
  );
  addTrial('Oldtrial', 'closed');
  mockedGetGuildRoster.mockResolvedValue([]);

  await syncRaiders(mockClient);

  const row = db.prepare('SELECT * FROM raiders WHERE character_name = ?').get('Oldtrial') as {
    missing_since: string | null;
  };
  expect(row.missing_since).not.toBeNull();
});

it('matches the trial exemption case-insensitively', async () => {
  const db = getDatabase();
  db.prepare('INSERT INTO raiders (character_name, discord_user_id) VALUES (?, ?)').run(
    'Etav',
    '999',
  );
  addTrial('etav');
  mockedGetGuildRoster.mockResolvedValue([]);

  await syncRaiders(mockClient);

  const row = db.prepare('SELECT * FROM raiders WHERE character_name = ?').get('Etav') as {
    missing_since: string | null;
  };
  expect(row.missing_since).toBeNull();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/integration/raids-flow.test.ts`
Expected: the three exemption tests FAIL (`missing_since` is a timestamp, not null); the closed-trial test passes already.

- [ ] **Step 3: Implement the exemption**

In `src/functions/raids/syncRaiders.ts`, after the `dbRaiderMap` construction near line 31, add the active-trial set:

```typescript
// Characters with an active trial. They are legitimately absent from the
// Raider.IO roster -- a fresh guild invite sits at rank 8, outside
// ROSTER_RANKS, and Raider.IO does not list a character it has not crawled --
// so the absence machinery below must leave their rows alone. Without this a
// trial's row is hidden 24h after it appears, which is the whole point of it.
const activeTrialNames = new Set(
  (
    db.prepare(`SELECT character_name FROM trials WHERE status = 'active'`).all() as {
      character_name: string;
    }[]
  ).map((t) => t.character_name.toLowerCase()),
);
```

Add a counter beside the existing ones (`let unhidden = 0;`), then in the absence pass, immediately after the `if (apiNameSet.has(...)) continue;` guard:

```typescript
if (activeTrialNames.has(raider.character_name.toLowerCase())) {
  // Self-heals a trial an earlier sync already stamped.
  if (raider.missing_since !== null || raider.inactive_since !== null) {
    db.prepare('UPDATE raiders SET missing_since = NULL, inactive_since = NULL WHERE id = ?').run(
      raider.id,
    );
    unhidden++;
    logger.info(
      'SyncRaiders',
      `Raider "${raider.character_name}" un-hidden: an active trial is exempt from the roster check`,
    );
  }
  continue;
}
```

Extend the completion log to carry the new counter:

```typescript
logger.info(
  'SyncRaiders',
  `Sync complete: ${added} added, ${returned} returned, ${reactivated} reactivated, ` +
    `${markedMissing} newly missing, ${markedInactive} newly inactive, ${unhidden} un-hidden`,
);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/integration/raids-flow.test.ts`
Expected: PASS, including the pre-existing tests.

- [ ] **Step 5: Verify the checks**

Run: `npx tsc --noEmit && npx eslint src/functions/raids/syncRaiders.ts tests/integration/raids-flow.test.ts && npx prettier --check src/functions/raids/syncRaiders.ts tests/integration/raids-flow.test.ts`
Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add src/functions/raids/syncRaiders.ts tests/integration/raids-flow.test.ts
git commit -F - <<'EOF'
feat(raids): active trials are exempt from the roster absence check

An active trial is legitimately missing from the Raider.IO roster, so stamping
them missing -- and hiding them 24h later, since every consumer filters on
inactive_since IS NULL -- defeats the purpose of giving them a row at all.

Also clears a stamp an earlier sync left, so a trial hidden before this shipped
comes back on the next tick. A closed trial is stamped as usual.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 3: Refresh roster-owned columns from the API

`raiders.realm`, `region`, `rank` and `class` are write-once today — no `SET rank`/`SET realm`/`SET class` exists anywhere in `src/`. An in-game promotion or realm transfer never propagates, and the guessed realm on a synthesised trial row would be permanent, silently dropping that character from the M+ alert (which looks characters up by name and realm).

**Files:**

- Modify: `src/functions/raids/syncRaiders.ts` (new pass after the existing "raiders back in the API roster" loop, currently ending line 98)
- Test: `tests/integration/raids-flow.test.ts`

**Interfaces:**

- Consumes: `RaiderIoMember` from `src/services/raiderio.js` (already imported by the test file as a type).
- Produces: no new exports.

- [ ] **Step 1: Write the failing tests**

Append inside the same top-level `describe` in `tests/integration/raids-flow.test.ts`:

```typescript
it('refreshes realm, region, rank and class when the roster disagrees', async () => {
  const db = getDatabase();
  db.prepare(
    'INSERT INTO raiders (character_name, realm, region, rank, class) VALUES (?, ?, ?, ?, ?)',
  ).run('Jovaz', 'silvermoon', 'eu', null, null);
  mockedGetGuildRoster.mockResolvedValue([makeMember('Jovaz', 4, 'draenor', 'eu', 'Warlock')]);

  await syncRaiders(mockClient);

  const row = db.prepare('SELECT * FROM raiders WHERE character_name = ?').get('Jovaz') as {
    realm: string;
    region: string;
    rank: number | null;
    class: string | null;
  };
  expect(row).toMatchObject({ realm: 'draenor', region: 'eu', rank: 4, class: 'Warlock' });
});

it('leaves a row alone when the roster agrees', async () => {
  const db = getDatabase();
  db.prepare(
    'INSERT INTO raiders (character_name, realm, region, rank, class) VALUES (?, ?, ?, ?, ?)',
  ).run('Jovaz', 'draenor', 'eu', 4, 'Warlock');
  mockedGetGuildRoster.mockResolvedValue([makeMember('Jovaz', 4, 'draenor', 'eu', 'Warlock')]);

  await syncRaiders(mockClient);

  const row = db.prepare('SELECT * FROM raiders WHERE character_name = ?').get('Jovaz') as {
    rank: number | null;
  };
  expect(row.rank).toBe(4);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/integration/raids-flow.test.ts`
Expected: the refresh test FAILS — realm is still `silvermoon`, rank still null. The agreement test passes already.

- [ ] **Step 3: Implement the refresh pass**

In `src/functions/raids/syncRaiders.ts`, add `let refreshed = 0;` beside the other counters, then insert this pass after the existing loop 2 and before loop 3 ("Handle new raiders from API"):

```typescript
// 2b. Refresh the columns the roster owns. These were write-once until now,
// so an in-game promotion or realm transfer never reached the row -- and a
// trial row inserted with a guessed realm would keep it forever, which
// silently drops that character from the M+ alert (it looks characters up
// by name and realm).
for (const member of filteredMembers) {
  const existing = dbRaiderMap.get(member.character.name.toLowerCase());
  if (!existing) continue;

  if (
    existing.realm === member.character.realm &&
    existing.region === member.character.region &&
    existing.rank === member.rank &&
    existing.class === member.character.class
  ) {
    continue;
  }

  db.prepare('UPDATE raiders SET realm = ?, region = ?, rank = ?, class = ? WHERE id = ?').run(
    member.character.realm,
    member.character.region,
    member.rank,
    member.character.class,
    existing.id,
  );
  refreshed++;
}
```

Add the counter to the completion log:

```typescript
logger.info(
  'SyncRaiders',
  `Sync complete: ${added} added, ${returned} returned, ${reactivated} reactivated, ` +
    `${markedMissing} newly missing, ${markedInactive} newly inactive, ${unhidden} un-hidden, ` +
    `${refreshed} refreshed`,
);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/integration/raids-flow.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify the checks**

Run: `npx tsc --noEmit && npx eslint src/functions/raids/syncRaiders.ts tests/integration/raids-flow.test.ts && npx prettier --check src/functions/raids/syncRaiders.ts tests/integration/raids-flow.test.ts`
Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add src/functions/raids/syncRaiders.ts tests/integration/raids-flow.test.ts
git commit -F - <<'EOF'
fix(raids): keep realm, region, rank and class in step with the roster

These columns were write-once -- nothing in src/ ever issued SET rank, SET
realm or SET class -- so an in-game promotion or realm transfer never reached
an existing row.

That also made the realm guessed for a synthesised trial row permanent, and a
wrong realm silently drops a character from the M+ alert, which looks them up
by name and realm.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 4: Wire the ensure step into `syncRaiders`

**Files:**

- Modify: `src/functions/raids/syncRaiders.ts`
- Test: `tests/integration/raids-flow.test.ts`

**Interfaces:**

- Consumes: `ensureRaidersForActiveTrials(db)` from Task 1 (`./ensureTrialRaiders.js`), returning `RaiderRow[]`; the `addTrial(name, status, discordUserId)` test helper added to `tests/integration/raids-flow.test.ts` by Task 2. If Task 2 has not run, add that helper here — its body is in Task 2, Step 1.
- Produces: no signature change. `syncRaiders` keeps returning `RaiderRow[]` of new unlinked raiders.

**Trap to avoid — read before implementing.** `dbRaiderMap` is currently built at line 31 from a read taken _before_ the transaction. If the ensure step inserts a row for a trial who _is_ in the filtered roster (a trial already promoted to a raiding rank), loop 3 would not see that row in the stale map and would `INSERT` the same `character_name` again — a UNIQUE constraint failure that rolls the whole sync back. So `dbRaiderMap` must be rebuilt from a fresh read after the ensure step. The last test below covers exactly this.

- [ ] **Step 1: Write the failing tests**

Append inside the same top-level `describe` in `tests/integration/raids-flow.test.ts`:

```typescript
it('adds a roster row for an active trial the roster does not list', async () => {
  const db = getDatabase();
  addTrial('Etav', 'active', '999');
  mockedGetGuildRoster.mockResolvedValue([]);

  await syncRaiders(mockClient);

  const row = db.prepare('SELECT * FROM raiders WHERE character_name = ?').get('Etav') as
    | { discord_user_id: string | null; missing_since: string | null }
    | undefined;
  expect(row?.discord_user_id).toBe('999');
  expect(row?.missing_since).toBeNull();
});

it('returns an unlinked trial row so auto-match and the linking post fire', async () => {
  addTrial('Etav', 'active', null);
  mockedGetGuildRoster.mockResolvedValue([]);

  const newUnlinked = await syncRaiders(mockClient);

  expect(newUnlinked.map((r) => r.character_name)).toEqual(['Etav']);
});

it('does not re-return the same trial row on the next sync', async () => {
  addTrial('Etav', 'active', null);
  mockedGetGuildRoster.mockResolvedValue([]);
  await syncRaiders(mockClient);

  expect(await syncRaiders(mockClient)).toEqual([]);
});

it('survives a trial who is already in the filtered roster', async () => {
  const db = getDatabase();
  addTrial('Etav', 'active', '999');
  mockedGetGuildRoster.mockResolvedValue([makeMember('Etav', 3, 'silvermoon', 'eu', 'Priest')]);

  await expect(syncRaiders(mockClient)).resolves.toBeDefined();

  const count = db
    .prepare('SELECT COUNT(*) AS n FROM raiders WHERE character_name = ?')
    .get('Etav') as { n: number };
  expect(count.n).toBe(1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/integration/raids-flow.test.ts`
Expected: the first three FAIL (no row / empty return). The fourth may pass by accident before the change — it is the regression guard for the trap above, and must still pass after.

- [ ] **Step 3: Implement the wiring**

Add the import at the top of `src/functions/raids/syncRaiders.ts`:

```typescript
import { ensureRaidersForActiveTrials } from './ensureTrialRaiders.js';
```

Delete the `dbRaiderMap` construction at line 31 (the `const dbRaiderMap = new Map(dbRaiders.map(...))` line). Then, as the first statement inside `db.transaction(() => {` — before the `const now` line and the absence pass — add:

```typescript
// 0. Every active trial gets a roster row. Runs before anything else so the
// rest of this sync sees the rows it creates, and so a row created here is
// never stamped by the pass below in the same run.
newUnlinkedRaiders.push(...ensureRaidersForActiveTrials(db));

// Re-read after the ensure step: a trial already promoted to a raiding rank
// is both freshly inserted above and present in filteredMembers, and a stale
// map would make loop 3 insert their name a second time -- a UNIQUE
// violation that rolls back the whole sync.
const dbRaiderMap = new Map(
  (db.prepare('SELECT * FROM raiders').all() as RaiderRow[]).map((r) => [
    r.character_name.toLowerCase(),
    r,
  ]),
);
```

`dbRaiders` (read at line 20, before the transaction) stays as it is: the absence and return passes should iterate the rows that existed before this sync.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/integration/raids-flow.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Run the whole suite — this task changes a function many tests touch**

Run: `npm test`
Expected: all files pass. If a test that stubs the DB now fails on `trials`, it is because `syncRaiders` reads that table; the fix is to let the test use `initDatabase(':memory:')` like the rest of the file, not to weaken the query.

- [ ] **Step 6: Verify the checks**

Run: `npx tsc --noEmit && npx eslint src/functions/raids/syncRaiders.ts tests/integration/raids-flow.test.ts && npx prettier --check src/functions/raids/syncRaiders.ts tests/integration/raids-flow.test.ts`
Expected: all clean.

- [ ] **Step 7: Commit**

```bash
git add src/functions/raids/syncRaiders.ts tests/integration/raids-flow.test.ts
git commit -F - <<'EOF'
feat(raids): the roster sync gives every active trial a row

Ensures rows first, so the rest of the sync sees them and nothing it creates is
stamped missing in the same run. Newly inserted unlinked rows join the return
value, so auto-match and the linking post treat a trial like any new raider,
once each.

dbRaiderMap is now read after the ensure step: a trial already promoted to a
raiding rank is both inserted here and present in the filtered roster, and a
stale map made the new-raider loop insert that name twice -- a UNIQUE violation
that rolled back the entire sync.

Backfills the trials already live; no manual DB writes needed.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 5: Insert the row at accept time

The sync covers this within ten minutes; this closes that window so an accepted applicant is a roster member immediately.

**Files:**

- Modify: `src/functions/applications/acceptApplication.ts` (after the `createTrialReviewThread` call, currently lines 261-276)
- Test: `tests/unit/acceptApplicationRosterRow.test.ts`

**Interfaces:**

- Consumes: `ensureRaiderForTrial(db, trial)` from Task 1, and `EnsurableTrial`.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/acceptApplicationRosterRow.test.ts`. This tests the ensure call against a real DB with the shape `acceptApplication` passes, rather than driving the whole Discord interaction — the handler needs a modal interaction, a guild, a forum channel and a DM to run end to end, and the existing suite does not have a harness for that.

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../src/database/db.js';
import type { RaiderRow } from '../../src/types/index.js';

vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { ensureRaiderForTrial } from '../../src/functions/raids/ensureTrialRaiders.js';

describe('accepting an application makes the applicant a roster member', () => {
  beforeEach(() => {
    closeDatabase();
    initDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
  });

  it('inserts a linked row using the applicant Discord id and the intel realm', () => {
    const db = getDatabase();
    db.prepare(
      `INSERT INTO applicant_intel_jobs (application_id, character_name, character_realm, character_region)
       VALUES (?, 'Etav', 'draenor', 'eu')`,
    ).run(42);

    // Exactly the object acceptApplication passes after createTrialReviewThread.
    const result = ensureRaiderForTrial(db, {
      character_name: 'Etav',
      discord_user_id: '178221862721945611',
      application_id: 42,
    });

    expect(result).toBe('inserted');
    const row = db
      .prepare('SELECT * FROM raiders WHERE character_name = ?')
      .get('Etav') as RaiderRow;
    expect(row.discord_user_id).toBe('178221862721945611');
    expect(row.realm).toBe('draenor');
  });
});
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `npx vitest run tests/unit/acceptApplicationRosterRow.test.ts`
Expected: PASS — it exercises Task 1's module. This test pins the contract `acceptApplication` depends on; Step 3 is what wires the caller.

- [ ] **Step 3: Add the call in `acceptApplication`**

Add the imports:

```typescript
import { ensureRaiderForTrial } from '../raids/ensureTrialRaiders.js';
```

Replace the existing `createTrialReviewThread` try/catch block (lines 261-276) with:

```typescript
// Create trial review thread
try {
  await createTrialReviewThread(interaction.client, {
    characterName,
    role,
    startDate,
    applicationId,
    discordUserId: application.applicant_user_id,
  });
  logger.info('Trials', `Created trial review from accepted application #${applicationId}`);
} catch (error) {
  logger.warn(
    'Trials',
    `Failed to create trial review for application #${applicationId}: ${error}`,
  );
}

// A trial is a roster member: give them a raiders row now rather than waiting
// up to ten minutes for the next sync, which would ensure it anyway. Never
// fails the accept -- the sync is the backstop.
try {
  ensureRaiderForTrial(db, {
    character_name: characterName,
    discord_user_id: application.applicant_user_id,
    application_id: applicationId,
  });
} catch (error) {
  logger.warn(
    'Applications',
    `Failed to add ${characterName} to the roster for application #${applicationId}: ${error}`,
  );
}
```

- [ ] **Step 4: Verify the checks and the full suite**

Run: `npx tsc --noEmit && npm test`
Expected: no type errors; all tests pass.

Run: `npx eslint src/functions/applications/acceptApplication.ts tests/unit/acceptApplicationRosterRow.test.ts && npx prettier --check src/functions/applications/acceptApplication.ts tests/unit/acceptApplicationRosterRow.test.ts`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/functions/applications/acceptApplication.ts tests/unit/acceptApplicationRosterRow.test.ts
git commit -F - <<'EOF'
feat(applications): accepting an application adds the trial to the roster

What an officer already expects to happen. The roster sync would ensure the row
within ten minutes regardless, so this is purely about closing that window, and
it never fails the accept.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 6: Verify against production data before promoting

No code changes. Confirms the change does what the reported bug needed.

- [ ] **Step 1: Confirm the whole suite and the CI-gating checks**

Run: `npm test && npx tsc --noEmit && npx eslint . && npx prettier --check .`
Expected: all pass. `prettier --check .` is what CI runs; eslint passing does not imply prettier passing.

- [ ] **Step 2: Check the two live trials are still the ones to watch**

Run:

```bash
railway ssh --service discord-bot -e prod "node -e \"const D=require('better-sqlite3');const d=new D(process.env.DB_PATH,{readonly:true});console.log(JSON.stringify(d.prepare(\\\"SELECT t.character_name, t.status, t.discord_user_id, (SELECT COUNT(*) FROM raiders r WHERE r.character_name = t.character_name COLLATE NOCASE) AS has_row FROM trials t WHERE t.status = 'active'\\\").all()));\""
```

Expected: active trials listed with `has_row: 0` for Etav and Neralia. Record the output in the handoff — it is the before-shot.

- [ ] **Step 3: Report and hand off the deploy decision**

Summarise for the user: tasks complete, suite green, commits local and unpushed. Deploying to test means pushing `main`, which restarts the test bot; promoting to prod is a fast-forward push of `main` to `prod`. Ask before either — do not push.

After deploy, the check to repeat is Step 2's query: `has_row` should be 1 for every active trial within ten minutes, with `missing_since` staying null.

---

## Notes for the implementer

- **`syncRaiders` is one function that four tasks touch.** Tasks 2, 3 and 4 each add one pass. Keep the numbered-comment structure the file already uses (`// 1.`, `// 2.`, `// 2b.`, `// 3.`) so the order stays readable.
- **The `raiders` table has one writer by design.** `syncRaiders` owns it; `acceptApplication` is the one exception, and it goes through the same `ensureRaiderForTrial` function rather than issuing its own INSERT. Do not add a third writer.
- **Why `resolveSignupMentions` is not simplified.** Once trials have rows, its first branch hits and the fallbacks are redundant _in the steady state_ — but not during the window between a trial being created and the row existing, and not if the ensure step is ever skipped for an ignored character. It has its own tests and costs nothing. Leave it.
- **Tests use `initDatabase(':memory:')`** with `closeDatabase()` in `beforeEach` and `afterEach`, following `tests/integration/raids-flow.test.ts`. The schema is created by `initDatabase`, so no manual `CREATE TABLE` is needed.
- **Do not run `/migrate` or write to the prod DB.** Nothing here needs a schema change: no new columns, no new tables.

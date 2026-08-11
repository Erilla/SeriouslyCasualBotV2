# Trial Departure Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tell overlords, in a trial's review post, when the Discord user behind an active trial leaves the server — live and via the boot sweep — mirroring the applicant-departure feature.

**Architecture:** A trial row has no Discord user id, so schema v13 adds `trials.discord_user_id` (best-effort back-filled) and `trials.departed_notified_at`. The existing `departureNotification.ts` builders are parameterised over subject rather than copied; a new `notifyTrialDeparture` mirrors `notifyApplicantDeparture`; the existing `guildMemberRemove` handler asks both questions, and `sweepDepartedApplicants` becomes `sweepDepartures` with an applications pass and a trials pass.

**Tech Stack:** TypeScript ESM (Node16 module resolution — every relative import ends `.js`), discord.js v14, better-sqlite3, vitest.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-11-trial-departure-notification-design.md`. Read it before starting.
- **Scope:** fires only for trials with `status = 'active'`. Never `promoted`, never `closed`.
- **Eligibility, always all three:** `status = 'active'` AND `discord_user_id` = the departed user AND `departed_notified_at IS NULL`.
- **Notify only.** Never modify `trials.status`, `trial_alerts` or `promote_alerts`.
- **Ordering, never reorder:** post → stamp → audit mirror. A failed post must leave the row unstamped.
- **Copy, exact:** post line is ``**<character>** <@<id>> (trial) has left the server. Close the trial to tidy it up.`` Audit title is exactly `Trial left the server`.
- **`allowedMentions` must be locked to the overlord ids** on every message built here — a character name is user-supplied.
- **discord.js v14 conventions:** `MessageFlags.Ephemeral`, never `ephemeral: true`.
- **Run tests with CI's env stubs**, or whole files silently drop out of the run:
  ```bash
  DISCORD_TOKEN=test-stub CLIENT_ID=test-stub GUILD_ID=test-stub OFFICER_ROLE_ID=test-stub \
  WOWAUDIT_API_SECRET=test-stub WARCRAFTLOGS_CLIENT_ID=test-stub WARCRAFTLOGS_CLIENT_SECRET=test-stub \
  WARCRAFTLOGS_GUILD_ID=0 BLIZZARD_CLIENT_ID=test-stub BLIZZARD_CLIENT_SECRET=test-stub \
  RAIDERIO_GUILD_IDS=0 npx vitest run <paths>
  ```
- **`npm run format:check` false-positives locally** (the checkout is CRLF). Verify a changed file with
  `npx prettier <file> | diff --strip-trailing-cr - <file>` instead.
- **Commit at the end of every task.** Never push to `main`; work stays on `feat/trial-departure-notification`.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/database/schema.ts` (modify) | Fresh-database DDL for the two new `trials` columns. |
| `src/database/db.ts` (modify) | Migration to v13: add the columns if absent, back-fill `discord_user_id`. |
| `src/types/index.ts` (modify) | `TrialRow` gains the two fields. |
| `src/functions/applications/departureNotification.ts` (modify) | Becomes subject-agnostic: builds the post line and audit detail for an applicant *or* a trial. |
| `src/functions/trial-review/notifyTrialDeparture.ts` (create) | Selection, send, stamp, mirror for one departed trial. The trial counterpart of `notifyApplicantDeparture`. |
| `src/functions/applications/sweepDepartedApplicants.ts` → `src/functions/departures/sweepDepartures.ts` (move + modify) | One boot sweep, two passes, shared membership check. |
| `src/events/guildMemberRemove.ts` (modify) | Live path asks both questions. |
| `src/events/ready.ts` (modify) | Calls `sweepDepartures`; startup line reports both counts. |
| `src/functions/trial-review/createTrialReviewThread.ts` (modify) | Accepts and stores `discordUserId`; resolves from `raiders` as a fallback. |
| `src/commands/trials.ts` (modify) | `discord_user` USER option on `create_thread` and on `change_trial_info`. |
| `src/interactions/trial.ts` (modify) | Carries the picked user id through the modal customId; reports coverage in the reply. |
| `src/functions/trial-review/changeTrialInfo.ts` (modify) | Accepts `discordUserId` in its updates. |
| `tests/unit/trialDeparture.test.ts` (create) | Copy, selection, delivery, handler. |
| `tests/unit/migrationV13.test.ts` (create) | Both back-fill routes, unknown left NULL, idempotence. |

---

### Task 1: Schema v13 — the two columns and the back-fill

**Files:**
- Modify: `src/database/schema.ts` (the `CREATE TABLE IF NOT EXISTS trials` block, ~line 99)
- Modify: `src/database/db.ts` (append after the `currentVersion < 12` block, ~line 307)
- Modify: `src/types/index.ts` (`TrialRow`, ~line 103)
- Test: `tests/unit/migrationV13.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `trials.discord_user_id TEXT` and `trials.departed_notified_at TEXT`; `TrialRow.discord_user_id: string | null` and `TrialRow.departed_notified_at: string | null`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/migrationV13.test.ts`. The migration runs inside `initDatabase`, so the test builds a *pre-v13* database by hand, then runs the migration against it. Read `tests/unit/testdata.test.ts` for the in-memory database idiom first.

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/database/db.js';

/**
 * A pre-v13 database: the trials table as it was, without either new column, plus
 * the two tables the back-fill reads from.
 */
function preV13(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
    INSERT INTO schema_version (version) VALUES (12);
    CREATE TABLE applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      applicant_user_id TEXT,
      status TEXT
    );
    CREATE TABLE raiders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_name TEXT NOT NULL UNIQUE,
      discord_user_id TEXT
    );
    CREATE TABLE trials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_name TEXT NOT NULL,
      role TEXT NOT NULL,
      start_date TEXT NOT NULL,
      thread_id TEXT,
      logs_message_id TEXT,
      application_id INTEGER REFERENCES applications(id),
      status TEXT DEFAULT 'active'
    );
  `);
  return db;
}

function trialColumns(db: Database.Database): string[] {
  return (db.pragma('table_info(trials)') as { name: string }[]).map((c) => c.name);
}

describe('migration v13 — trial departure columns', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = preV13();
  });
  afterEach(() => db.close());

  it('adds both columns', () => {
    runMigrations(db);

    expect(trialColumns(db)).toContain('discord_user_id');
    expect(trialColumns(db)).toContain('departed_notified_at');
  });

  it('back-fills discord_user_id from the linked application', () => {
    db.prepare("INSERT INTO applications (id, applicant_user_id, status) VALUES (7, 'u-app', 'accepted')").run();
    db.prepare(
      `INSERT INTO trials (character_name, role, start_date, application_id)
       VALUES ('Fromapp', 'dps', '2026-08-01', 7)`,
    ).run();

    runMigrations(db);

    const row = db.prepare('SELECT discord_user_id FROM trials WHERE character_name = ?').get('Fromapp');
    expect(row).toEqual({ discord_user_id: 'u-app' });
  });

  it('back-fills discord_user_id from raiders when there is no application link', () => {
    db.prepare("INSERT INTO raiders (character_name, discord_user_id) VALUES ('Fromraider', 'u-raider')").run();
    db.prepare(
      `INSERT INTO trials (character_name, role, start_date) VALUES ('Fromraider', 'heal', '2026-08-01')`,
    ).run();

    runMigrations(db);

    const row = db.prepare('SELECT discord_user_id FROM trials WHERE character_name = ?').get('Fromraider');
    expect(row).toEqual({ discord_user_id: 'u-raider' });
  });

  it('prefers the application link over a conflicting raiders row', () => {
    db.prepare("INSERT INTO applications (id, applicant_user_id, status) VALUES (8, 'u-app', 'accepted')").run();
    db.prepare("INSERT INTO raiders (character_name, discord_user_id) VALUES ('Both', 'u-raider')").run();
    db.prepare(
      `INSERT INTO trials (character_name, role, start_date, application_id)
       VALUES ('Both', 'dps', '2026-08-01', 8)`,
    ).run();

    runMigrations(db);

    const row = db.prepare('SELECT discord_user_id FROM trials WHERE character_name = ?').get('Both');
    expect(row).toEqual({ discord_user_id: 'u-app' });
  });

  it('leaves a genuinely unknown trial NULL rather than guessing', () => {
    db.prepare(
      `INSERT INTO trials (character_name, role, start_date) VALUES ('Nobody', 'dps', '2026-08-01')`,
    ).run();

    runMigrations(db);

    const row = db.prepare('SELECT discord_user_id FROM trials WHERE character_name = ?').get('Nobody');
    expect(row).toEqual({ discord_user_id: null });
  });

  it('never overwrites a departed_notified_at stamp, and is safe to run twice', () => {
    db.prepare("INSERT INTO raiders (character_name, discord_user_id) VALUES ('Twice', 'u-raider')").run();
    db.prepare(
      `INSERT INTO trials (character_name, role, start_date) VALUES ('Twice', 'dps', '2026-08-01')`,
    ).run();

    runMigrations(db);
    db.prepare("UPDATE trials SET departed_notified_at = '2026-08-11 12:00:00' WHERE character_name = 'Twice'").run();
    runMigrations(db);

    const row = db
      .prepare('SELECT discord_user_id, departed_notified_at FROM trials WHERE character_name = ?')
      .get('Twice');
    expect(row).toEqual({ discord_user_id: 'u-raider', departed_notified_at: '2026-08-11 12:00:00' });
  });
});
```

- [ ] **Step 2: Note where the migration lives**

`runMigrations(database)` is already exported from `src/database/db.ts:38`, and reads the current
version once at line 50 as `applied?.version ?? 0` from `schema_version`. The test above calls it
directly — no change needed to make it testable, and the version guards mean a second call on an
already-migrated database is a no-op, which is what the idempotence test relies on.

- [ ] **Step 3: Run the test to verify it fails**

Run (with the env stubs from Global Constraints): `npx vitest run tests/unit/migrationV13.test.ts`
Expected: FAIL — `expect(trialColumns(db)).toContain('discord_user_id')` fails, since nothing adds the column yet.

- [ ] **Step 4: Add the columns to the fresh-database DDL**

In `src/database/schema.ts`, the trials table becomes:

```sql
    CREATE TABLE IF NOT EXISTS trials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_name TEXT NOT NULL,
      role TEXT NOT NULL,
      start_date TEXT NOT NULL,
      thread_id TEXT,
      logs_message_id TEXT,
      application_id INTEGER REFERENCES applications(id),
      status TEXT DEFAULT 'active',
      discord_user_id TEXT,
      departed_notified_at TEXT
    );
```

- [ ] **Step 5: Add the v13 migration**

In `src/database/db.ts`, immediately after the `if (currentVersion < 12) { ... }` block:

```typescript
  if (currentVersion < 13) {
    // Trial departures. Two columns, for two different reasons.
    //
    // `discord_user_id` exists because a trial row never knew whose Discord account
    // it was: it carries a character name and, only sometimes, an application link.
    // Storing the id is what makes the notification possible at all, and it survives
    // a character rename in a way a name match would not.
    //
    // `departed_notified_at` is the durable once-only marker, exactly as v12 added
    // for applications: the gateway event is missed on every redeploy, and the boot
    // sweep that catches up would otherwise re-notify forever.
    //
    // Same guards as v12: table_info returns [] for a missing table, so check
    // sqlite_master first or the ALTER throws.
    database.transaction(() => {
      const tableExists = database
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='trials'")
        .get();
      if (tableExists) {
        const cols = database.pragma('table_info(trials)') as { name: string }[];
        if (!cols.some((c) => c.name === 'discord_user_id')) {
          database.exec('ALTER TABLE trials ADD COLUMN discord_user_id TEXT');
        }
        if (!cols.some((c) => c.name === 'departed_notified_at')) {
          database.exec('ALTER TABLE trials ADD COLUMN departed_notified_at TEXT');
        }

        // Best-effort back-fill, application link first: it is the exact record of
        // who applied, where a character-name match is an inference. Both are
        // guarded on `discord_user_id IS NULL`, so this cannot clobber an id an
        // officer has since set, and re-running is a no-op.
        const hasApplications = database
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='applications'")
          .get();
        if (hasApplications) {
          database.exec(`
            UPDATE trials SET discord_user_id = (
              SELECT a.applicant_user_id FROM applications a WHERE a.id = trials.application_id
            )
            WHERE discord_user_id IS NULL AND application_id IS NOT NULL
          `);
        }

        const hasRaiders = database
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='raiders'")
          .get();
        if (hasRaiders) {
          database.exec(`
            UPDATE trials SET discord_user_id = (
              SELECT r.discord_user_id FROM raiders r
               WHERE r.character_name = trials.character_name AND r.discord_user_id IS NOT NULL
            )
            WHERE discord_user_id IS NULL
          `);
        }
      }
      database.prepare('INSERT INTO schema_version (version) VALUES (?)').run(13);
    })();
  }
```

Note: the application sub-select can itself yield NULL (an application row with no `applicant_user_id`), which leaves the column NULL and lets the raiders pass try — which is the behaviour we want.

- [ ] **Step 6: Extend `TrialRow`**

In `src/types/index.ts`:

```typescript
export interface TrialRow {
  id: number;
  character_name: string;
  role: string;
  start_date: string;
  thread_id: string | null;
  logs_message_id: string | null;
  application_id: number | null;
  status: 'active' | 'promoted' | 'closed';
  /** Whose Discord account this trial is; NULL when nobody has linked it. */
  discord_user_id: string | null;
  /** When overlords were told this trial left the Discord; NULL if they have not been. */
  departed_notified_at: string | null;
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run tests/unit/migrationV13.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 8: Run the whole suite and typecheck**

Run: `npx tsc --noEmit` then `npm test` (with env stubs).
Expected: no type errors; all tests pass. If a test constructs a `TrialRow` literal it may now fail to typecheck — add the two fields as `null` there.

- [ ] **Step 9: Commit**

```bash
git add src/database/schema.ts src/database/db.ts src/types/index.ts tests/unit/migrationV13.test.ts
git commit -m "feat(trials): schema v13 — discord_user_id and departed_notified_at on trials"
```

---

### Task 2: Parameterise the departure notification builders

**Files:**
- Modify: `src/functions/applications/departureNotification.ts`
- Modify: `tests/unit/applicantDeparture.test.ts` (the copy tests, ~lines 38-70, only if the call signature changes for them)
- Test: `tests/unit/trialDeparture.test.ts` (create — copy tests only in this task)

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```typescript
  export interface DepartureFacts {
    subject: 'applicant' | 'trial';
    /** applications.character_name is nullable; trials.character_name is not. */
    characterName: string | null;
    tag: string;
    userId: string;
    /** `application #12` / `trial #4` — the reference shown in the audit detail. */
    reference: string;
    /** The closing instruction in the post line. */
    closingAction: string;
  }
  export function buildDepartureNotification(overlordIds: string[], facts: DepartureFacts): MessageCreateOptions;
  export function buildDepartureAuditDetail(facts: DepartureFacts): string;
  export const DEPARTURE_AUDIT_TITLE: string;      // 'Applicant left the server'
  export const TRIAL_DEPARTURE_AUDIT_TITLE: string; // 'Trial left the server'
  ```
  The old field names `applicantTag`, `applicantUserId` and `applicationId` are gone; `notifyApplicantDeparture` is updated to the new shape in this task.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/trialDeparture.test.ts` with the copy tests. Read `tests/unit/applicantDeparture.test.ts` first and follow its structure exactly.

```typescript
import { describe, it, expect } from 'vitest';
import {
  buildDepartureNotification,
  buildDepartureAuditDetail,
  TRIAL_DEPARTURE_AUDIT_TITLE,
  type DepartureFacts,
} from '../../src/functions/applications/departureNotification.js';

const trialFacts: DepartureFacts = {
  subject: 'trial',
  characterName: 'Brentpriest',
  tag: 'brent#0001',
  userId: '100000000000000001',
  reference: 'trial #4',
  closingAction: 'Close the trial to tidy it up.',
};

describe('trial departure copy', () => {
  it('pings the overlords, names the character and says how to close it', () => {
    const message = buildDepartureNotification(['o1', 'o2'], trialFacts);

    expect(message.content).toBe(
      '<@o1> <@o2>\n' +
        '**Brentpriest** <@100000000000000001> (trial) has left the server. ' +
        'Close the trial to tidy it up.',
    );
  });

  it('restricts mentions to the overlord ids, so a character name cannot ping', () => {
    const message = buildDepartureNotification(['o1'], { ...trialFacts, characterName: '@everyone' });

    expect(message.allowedMentions).toEqual({ users: ['o1'] });
  });

  it('omits the mention line entirely when no overlords are configured', () => {
    const message = buildDepartureNotification([], trialFacts);

    expect(message.content).toBe(
      '**Brentpriest** <@100000000000000001> (trial) has left the server. ' +
        'Close the trial to tidy it up.',
    );
  });

  it('carries the raw user id and the trial reference in the audit detail', () => {
    expect(buildDepartureAuditDetail(trialFacts)).toBe(
      'Brentpriest <@100000000000000001> (trial) — trial #4, user id `100000000000000001`',
    );
  });

  it('has its own audit title, so a trial departure is not filed as an applicant one', () => {
    expect(TRIAL_DEPARTURE_AUDIT_TITLE).toBe('Trial left the server');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/trialDeparture.test.ts`
Expected: FAIL — `TRIAL_DEPARTURE_AUDIT_TITLE` is not exported.

- [ ] **Step 3: Rewrite the builders subject-agnostically**

Replace the body of `src/functions/applications/departureNotification.ts`:

```typescript
import type { MessageCreateOptions } from 'discord.js';

/** Title used for the audit-channel mirror of an applicant departure. */
export const DEPARTURE_AUDIT_TITLE = 'Applicant left the server';
/** Its trial counterpart, so the two are distinguishable in the audit channel. */
export const TRIAL_DEPARTURE_AUDIT_TITLE = 'Trial left the server';

export interface DepartureFacts {
  /** How the leaver is labelled in the message: `(applicant)` or `(trial)`. */
  subject: 'applicant' | 'trial';
  /** `applications.character_name` is nullable, so the tag is the fallback. A
   *  trial's is NOT NULL, so for trials this is always set. */
  characterName: string | null;
  tag: string;
  userId: string;
  /** `application #12` / `trial #4`, for the audit detail. */
  reference: string;
  /** The closing instruction: how to close this thing off. */
  closingAction: string;
}

/**
 * The character name if there is one, else the Discord tag — the one identifier
 * that always exists, and what an overlord would search for.
 */
function displayName(facts: DepartureFacts): string {
  return facts.characterName ?? facts.tag;
}

/**
 * The leaver, mentioned and labelled. The mention is inert: it is never listed in
 * `allowedMentions`, and they have left the guild anyway. It earns its place by
 * rendering as their current display name rather than a tag that may already be
 * stale.
 */
function subjectReference(facts: DepartureFacts): string {
  return `<@${facts.userId}> (${facts.subject})`;
}

/**
 * Build the "X left" notification for the post overlords already watch.
 *
 * Deliberately the same shape as `buildOverlordNotification`: one plain line
 * rather than an embed. Embeds in this bot carry content (voting, intel,
 * recruitment), and a red one reads as an error rather than an event.
 *
 * `allowedMentions` is locked to the explicit overlord ids because the character
 * name is user-supplied, so a crafted name like `@everyone` must render as literal
 * text. This holds for both subjects: an applicant types their own name, and an
 * officer types a trial's.
 */
export function buildDepartureNotification(
  overlordIds: string[],
  facts: DepartureFacts,
): MessageCreateOptions {
  const sentence =
    `**${displayName(facts)}** ${subjectReference(facts)} has left the server. ` +
    facts.closingAction;
  // No overlords configured means no mention line at all — not a leading blank.
  const mentions = overlordIds.map((id) => `<@${id}>`).join(' ');

  return {
    content: mentions ? `${mentions}\n${sentence}` : sentence,
    allowedMentions: { users: overlordIds },
  };
}

/**
 * The audit-channel mirror's detail line. Same facts as the post, plus the raw
 * user id — useful for a ban or an audit-log search, and out of place in prose.
 */
export function buildDepartureAuditDetail(facts: DepartureFacts): string {
  return (
    `${displayName(facts)} ${subjectReference(facts)} — ` +
    `${facts.reference}, user id \`${facts.userId}\``
  );
}
```

- [ ] **Step 4: Update the applicant caller to the new field names**

In `src/functions/applications/notifyApplicantDeparture.ts`, the `facts` literal becomes:

```typescript
  const facts: DepartureFacts = {
    subject: 'applicant',
    characterName: application.character_name,
    tag: applicant.tag,
    userId: applicant.userId,
    reference: `application #${application.id}`,
    closingAction: 'Reject the application to close it off.',
  };
```

Add `type DepartureFacts` to its existing import from `./departureNotification.js`.

- [ ] **Step 5: Run both departure test files**

Run: `npx vitest run tests/unit/trialDeparture.test.ts tests/unit/applicantDeparture.test.ts`
Expected: PASS. The applicant copy tests assert the rendered strings, which have not changed. If any of them construct `DepartureFacts` literals directly, update those literals to the new field names — the assertions themselves must not change, because the applicant message is not changing.

- [ ] **Step 6: Typecheck and run the whole suite**

Run: `npx tsc --noEmit` then `npm test` (with env stubs).
Expected: clean. Type errors point at any other `DepartureFacts` literal still using `applicantTag` / `applicantUserId` / `applicationId`.

- [ ] **Step 7: Commit**

```bash
git add src/functions/applications/departureNotification.ts src/functions/applications/notifyApplicantDeparture.ts tests/unit/trialDeparture.test.ts tests/unit/applicantDeparture.test.ts
git commit -m "refactor(departures): make the notification builders subject-agnostic"
```

---

### Task 3: `notifyTrialDeparture` — selection, send, stamp, mirror

**Files:**
- Create: `src/functions/trial-review/notifyTrialDeparture.ts`
- Test: `tests/unit/trialDeparture.test.ts` (append)

**Interfaces:**
- Consumes: `buildDepartureNotification`, `buildDepartureAuditDetail`, `TRIAL_DEPARTURE_AUDIT_TITLE`, `DepartureFacts` from Task 2; `trials.discord_user_id` / `departed_notified_at` from Task 1.
- Produces:
  ```typescript
  export interface DepartedTrialMember { userId: string; tag: string }
  export type TrialDepartureOutcome = 'notified' | 'no_trial' | 'no_thread' | 'send_failed';
  export function findUnnotifiedDepartureTrial(discordUserId: string): { id: number; character_name: string; thread_id: string | null } | undefined;
  export function notifyTrialDeparture(guild: Guild, member: DepartedTrialMember): Promise<TrialDepartureOutcome>;
  ```

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/trialDeparture.test.ts`. Mirror the `notifyApplicantDeparture` describe block in `tests/unit/applicantDeparture.test.ts` — copy its mocking of `../../src/services/auditLog.js` and `../raids/overlords.js` and its fake-guild helper rather than inventing new ones.

```typescript
import { beforeEach, afterEach, vi } from 'vitest';
import { closeDatabase, getDatabase } from '../../src/database/db.js';
import { createTables } from '../../src/database/schema.js';

vi.mock('../../src/services/auditLog.js', () => ({ auditNotice: vi.fn(async () => undefined) }));
vi.mock('../../src/functions/raids/overlords.js', () => ({
  getOverlords: vi.fn(() => [{ user_id: 'o1' }]),
}));

import { auditNotice } from '../../src/services/auditLog.js';
import { notifyTrialDeparture } from '../../src/functions/trial-review/notifyTrialDeparture.js';

/** A guild whose one thread records what was sent to it. */
function fakeGuild(send: (options: unknown) => Promise<void>) {
  const thread = { id: 'THREAD', isTextBased: () => true, send };
  return {
    channels: { cache: new Map([['THREAD', thread]]), fetch: async () => thread },
  } as never;
}

function seedTrial(over: Partial<{ status: string; userId: string | null; threadId: string | null; notifiedAt: string | null }> = {}): number {
  const { status = 'active', userId = 'u1', threadId = 'THREAD', notifiedAt = null } = over;
  return Number(
    getDatabase()
      .prepare(
        `INSERT INTO trials (character_name, role, start_date, thread_id, status, discord_user_id, departed_notified_at)
         VALUES ('Brentpriest', 'dps', '2026-08-01', ?, ?, ?, ?)`,
      )
      .run(threadId, status, userId, notifiedAt).lastInsertRowid,
  );
}

describe('notifyTrialDeparture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createTables(getDatabase(':memory:'));
  });
  afterEach(() => closeDatabase());

  it('posts to the trial thread and stamps the row exactly once', async () => {
    const trialId = seedTrial();
    const send = vi.fn(async () => undefined);

    const first = await notifyTrialDeparture(fakeGuild(send), { userId: 'u1', tag: 'brent#0001' });
    const second = await notifyTrialDeparture(fakeGuild(send), { userId: 'u1', tag: 'brent#0001' });

    expect(first).toBe('notified');
    expect(second).toBe('no_trial');
    expect(send).toHaveBeenCalledOnce();
    const row = getDatabase().prepare('SELECT departed_notified_at FROM trials WHERE id = ?').get(trialId) as { departed_notified_at: string | null };
    expect(row.departed_notified_at).not.toBeNull();
  });

  it('mirrors to the audit channel without a ping', async () => {
    seedTrial();

    await notifyTrialDeparture(fakeGuild(vi.fn(async () => undefined)), { userId: 'u1', tag: 'brent#0001' });

    expect(auditNotice).toHaveBeenCalledWith(
      'Trial left the server',
      expect.stringContaining('user id `u1`'),
    );
  });

  it.each([['promoted'], ['closed']])('ignores a %s trial', async (status) => {
    seedTrial({ status });
    const send = vi.fn(async () => undefined);

    await expect(notifyTrialDeparture(fakeGuild(send), { userId: 'u1', tag: 'brent#0001' })).resolves.toBe('no_trial');
    expect(send).not.toHaveBeenCalled();
  });

  it('ignores a trial whose Discord user was never linked', async () => {
    seedTrial({ userId: null });
    const send = vi.fn(async () => undefined);

    await expect(notifyTrialDeparture(fakeGuild(send), { userId: 'u1', tag: 'brent#0001' })).resolves.toBe('no_trial');
    expect(send).not.toHaveBeenCalled();
  });

  it('ignores a trial already notified about', async () => {
    seedTrial({ notifiedAt: '2026-08-10 10:00:00' });

    await expect(
      notifyTrialDeparture(fakeGuild(vi.fn(async () => undefined)), { userId: 'u1', tag: 'brent#0001' }),
    ).resolves.toBe('no_trial');
  });

  it('does not stamp the row when the post fails, so the sweep can retry', async () => {
    const trialId = seedTrial();
    const send = vi.fn(async () => {
      throw new Error('missing permissions');
    });

    await expect(notifyTrialDeparture(fakeGuild(send), { userId: 'u1', tag: 'brent#0001' })).resolves.toBe('send_failed');
    const row = getDatabase().prepare('SELECT departed_notified_at FROM trials WHERE id = ?').get(trialId) as { departed_notified_at: string | null };
    expect(row.departed_notified_at).toBeNull();
  });

  it('does not stamp the row when the trial has no thread recorded', async () => {
    const trialId = seedTrial({ threadId: null });

    await expect(
      notifyTrialDeparture(fakeGuild(vi.fn(async () => undefined)), { userId: 'u1', tag: 'brent#0001' }),
    ).resolves.toBe('no_thread');
    const row = getDatabase().prepare('SELECT departed_notified_at FROM trials WHERE id = ?').get(trialId) as { departed_notified_at: string | null };
    expect(row.departed_notified_at).toBeNull();
  });

  it('stamps the row even when the audit mirror throws — the post is what matters', async () => {
    const trialId = seedTrial();
    vi.mocked(auditNotice).mockRejectedValueOnce(new Error('audit channel gone'));

    await expect(
      notifyTrialDeparture(fakeGuild(vi.fn(async () => undefined)), { userId: 'u1', tag: 'brent#0001' }),
    ).resolves.toBe('notified');
    const row = getDatabase().prepare('SELECT departed_notified_at FROM trials WHERE id = ?').get(trialId) as { departed_notified_at: string | null };
    expect(row.departed_notified_at).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/trialDeparture.test.ts`
Expected: FAIL — cannot resolve `../../src/functions/trial-review/notifyTrialDeparture.js`.

- [ ] **Step 3: Write the implementation**

Create `src/functions/trial-review/notifyTrialDeparture.ts`:

```typescript
import type { Guild } from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';
import { auditNotice } from '../../services/auditLog.js';
import { asSendable } from '../../utils.js';
import { getOverlords } from '../raids/overlords.js';
import {
  TRIAL_DEPARTURE_AUDIT_TITLE,
  buildDepartureAuditDetail,
  buildDepartureNotification,
  type DepartureFacts,
} from '../applications/departureNotification.js';

/** The subset of a trial row a departure notification needs. */
interface DepartureTrial {
  id: number;
  character_name: string;
  thread_id: string | null;
}

export interface DepartedTrialMember {
  userId: string;
  /** Discord tag, for the logs — a trial always has a character name for the copy. */
  tag: string;
}

export type TrialDepartureOutcome = 'notified' | 'no_trial' | 'no_thread' | 'send_failed';

/**
 * The trial this departure concerns, if there is one to tell overlords about.
 *
 * `status = 'active'` is a trial in progress. `promoted` is deliberately excluded:
 * they are a full raider by then, and a raider leaving is a different event with a
 * different audience. `closed` is over.
 *
 * A NULL `discord_user_id` cannot match, which is how trials nobody has linked stay
 * silent rather than being guessed at. A non-NULL `departed_notified_at` means
 * overlords have already been told, which is what stops the boot sweep re-notifying
 * after every redeploy.
 */
export function findUnnotifiedDepartureTrial(discordUserId: string): DepartureTrial | undefined {
  return getDatabase()
    .prepare(
      `SELECT id, character_name, thread_id FROM trials
        WHERE discord_user_id = ?
          AND status = 'active'
          AND departed_notified_at IS NULL
        ORDER BY id DESC LIMIT 1`,
    )
    .get(discordUserId) as DepartureTrial | undefined;
}

function markNotified(trialId: number): void {
  getDatabase()
    .prepare("UPDATE trials SET departed_notified_at = datetime('now') WHERE id = ?")
    .run(trialId);
}

/**
 * Tell overlords that a trial in progress has left the Discord.
 *
 * The trial counterpart of `notifyApplicantDeparture`, and deliberately its twin:
 * shared by the live `guildMemberRemove` handler and the boot sweep, so both paths
 * produce the same message and the same once-only guarantee. Callers do not need to
 * check eligibility first — this returns `no_trial` when there is nothing to report.
 *
 * Notify only. The trial's status, its review alerts and its promote alerts are all
 * left alone: clicking **Close trial** already cancels the alerts, so the nudge to
 * close is what stops the noise, and nothing is decided for the officers.
 *
 * The row is stamped only after the post succeeds, so a failure leaves the work for
 * the next sweep rather than silently swallowing the notification. The audit mirror
 * is best-effort and never blocks the stamp: it is a searchable record of something
 * overlords have already been pinged about.
 */
export async function notifyTrialDeparture(
  guild: Guild,
  member: DepartedTrialMember,
): Promise<TrialDepartureOutcome> {
  const trial = findUnnotifiedDepartureTrial(member.userId);
  if (!trial) return 'no_trial';

  if (!trial.thread_id) {
    logger.warn(
      'Trials',
      `Trial #${trial.id}: ${trial.character_name} left, but the trial has no thread to post in`,
    );
    return 'no_thread';
  }

  const facts: DepartureFacts = {
    subject: 'trial',
    characterName: trial.character_name,
    tag: member.tag,
    userId: member.userId,
    reference: `trial #${trial.id}`,
    closingAction: 'Close the trial to tidy it up.',
  };

  const channel =
    guild.channels.cache.get(trial.thread_id) ??
    (await guild.channels.fetch(trial.thread_id).catch(() => null));
  const thread = asSendable(channel);
  if (!thread) {
    logger.warn('Trials', `Trial #${trial.id}: thread ${trial.thread_id} is missing or not sendable`);
    return 'no_thread';
  }

  try {
    const overlordIds = getOverlords().map((overlord) => overlord.user_id);
    await thread.send(buildDepartureNotification(overlordIds, facts));
  } catch (error) {
    logger.error(
      'Trials',
      `Trial #${trial.id}: failed to post departure notification: ${error}`,
      error as Error,
    );
    return 'send_failed';
  }

  markNotified(trial.id);
  logger.info(
    'Trials',
    `Trial #${trial.id}: notified overlords that ${trial.character_name} (${member.tag}) left the server`,
  );

  // Best-effort, and after the stamp: auditNotice swallows its own failures, but a
  // rejected promise here must not undo a notification that already landed.
  await auditNotice(TRIAL_DEPARTURE_AUDIT_TITLE, buildDepartureAuditDetail(facts)).catch(
    () => undefined,
  );

  return 'notified';
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/trialDeparture.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/functions/trial-review/notifyTrialDeparture.ts tests/unit/trialDeparture.test.ts
git commit -m "feat(trials): notify overlords in the trial post when a trial leaves"
```

---

### Task 4: Live path — one handler, both questions

**Files:**
- Modify: `src/events/guildMemberRemove.ts`
- Test: `tests/unit/trialDeparture.test.ts` (append)

**Interfaces:**
- Consumes: `notifyTrialDeparture` from Task 3.
- Produces: no new exports. The handler calls `notifyApplicantDeparture` then `notifyTrialDeparture`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/trialDeparture.test.ts`. Follow the handler describe block in `tests/unit/applicantDeparture.test.ts` for how it mocks the notifiers and builds a fake member.

```typescript
vi.mock('../../src/functions/applications/notifyApplicantDeparture.js', () => ({
  notifyApplicantDeparture: vi.fn(async () => 'no_application'),
}));
vi.mock('../../src/functions/trial-review/notifyTrialDeparture.js', () => ({
  notifyTrialDeparture: vi.fn(async () => 'notified'),
}));

import { config } from '../../src/config.js';
import handler from '../../src/events/guildMemberRemove.js';
import { notifyApplicantDeparture } from '../../src/functions/applications/notifyApplicantDeparture.js';
import { notifyTrialDeparture as mockedNotifyTrial } from '../../src/functions/trial-review/notifyTrialDeparture.js';

function fakeMember(over: Partial<{ guildId: string; bot: boolean }> = {}) {
  const { guildId = config.guildId, bot = false } = over;
  return {
    guild: { id: guildId },
    user: { id: 'u1', tag: 'brent#0001', bot },
  } as never;
}

describe('guildMemberRemove asks about trials as well as applications', () => {
  beforeEach(() => vi.clearAllMocks());

  it('asks both questions for a real departure', async () => {
    await handler.execute(fakeMember());

    expect(notifyApplicantDeparture).toHaveBeenCalledOnce();
    expect(mockedNotifyTrial).toHaveBeenCalledWith(expect.anything(), {
      userId: 'u1',
      tag: 'brent#0001',
    });
  });

  it('still asks about the trial when the applicant lookup throws', async () => {
    vi.mocked(notifyApplicantDeparture).mockRejectedValueOnce(new Error('db gone'));

    await handler.execute(fakeMember());

    expect(mockedNotifyTrial).toHaveBeenCalledOnce();
  });

  it('never throws back into the gateway when the trial lookup fails', async () => {
    vi.mocked(mockedNotifyTrial).mockRejectedValueOnce(new Error('thread exploded'));

    await expect(handler.execute(fakeMember())).resolves.toBeUndefined();
  });

  it('ignores bots', async () => {
    await handler.execute(fakeMember({ bot: true }));

    expect(mockedNotifyTrial).not.toHaveBeenCalled();
  });

  it('ignores departures from another guild', async () => {
    await handler.execute(fakeMember({ guildId: 'some-other-guild' }));

    expect(mockedNotifyTrial).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/trialDeparture.test.ts`
Expected: FAIL — `notifyTrialDeparture` is never called, because the handler does not call it yet.

- [ ] **Step 3: Update the handler**

In `src/events/guildMemberRemove.ts`, add the import and replace the single call. Each notifier gets its **own** try/catch, because one failing must not skip the other — a departed member can only be one of the two, but a database error on the first lookup must not silently drop the second.

```typescript
import { notifyTrialDeparture } from '../functions/trial-review/notifyTrialDeparture.js';
```

```typescript
    const departed = { userId: member.user.id, tag: member.user.tag };

    // Two independent questions, each in its own try/catch: a failure answering one
    // must not skip the other, and nothing may escape a gateway handler — an
    // unhandled rejection here takes the process down over a notification.
    try {
      await notifyApplicantDeparture(member.guild, departed);
    } catch (error) {
      logger.error(
        'Applications',
        `Failed to handle departure of ${departed.tag}: ${error}`,
        error as Error,
      );
    }

    try {
      await notifyTrialDeparture(member.guild, departed);
    } catch (error) {
      logger.error(
        'Trials',
        `Failed to handle trial departure of ${departed.tag}: ${error}`,
        error as Error,
      );
    }
```

Update the handler's doc comment: it tells overlords when the user behind an undecided application **or an active trial** leaves.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/trialDeparture.test.ts tests/unit/applicantDeparture.test.ts`
Expected: PASS both files.

- [ ] **Step 5: Commit**

```bash
git add src/events/guildMemberRemove.ts tests/unit/trialDeparture.test.ts
git commit -m "feat(trials): ask about trial departures on the live gateway path"
```

---

### Task 5: Boot sweep — `sweepDepartures` with two passes

**Files:**
- Move: `src/functions/applications/sweepDepartedApplicants.ts` → `src/functions/departures/sweepDepartures.ts`
- Modify: `src/events/ready.ts` (~lines 14, 163-165, 180-181)
- Test: `tests/unit/applicantDeparture.test.ts` (its sweep describe block — update the import path), `tests/unit/trialDeparture.test.ts` (append trial-pass tests)

**Interfaces:**
- Consumes: `notifyTrialDeparture` from Task 3; the existing `membershipOf` logic in the moved file.
- Produces:
  ```typescript
  export interface DepartureSweepResult { checked: number; notified: number; unresolved: number }
  export interface DeparturesSweepResult { applications: DepartureSweepResult; trials: DepartureSweepResult }
  export function sweepDepartures(guild: Guild): Promise<DeparturesSweepResult>;
  ```
  `sweepDepartedApplicants` no longer exists.

- [ ] **Step 1: Move the file and re-point its importers**

```bash
mkdir -p src/functions/departures
git mv src/functions/applications/sweepDepartedApplicants.ts src/functions/departures/sweepDepartures.ts
grep -rn "sweepDepartedApplicants" --include="*.ts" src tests
```

Fix every path the grep reports. Inside the moved file the relative imports gain a level: `../../database/db.js` stays two levels (both directories are two deep under `src`), but `./notifyApplicantDeparture.js` becomes `../applications/notifyApplicantDeparture.js`. Let `npx tsc --noEmit` find the rest.

- [ ] **Step 2: Write the failing tests**

Append to `tests/unit/trialDeparture.test.ts` a sweep describe block. Read the existing sweep tests in `tests/unit/applicantDeparture.test.ts` and reuse their fake-guild-with-`members.fetch` helper, including how they build a `DiscordAPIError` with code 10007.

```typescript
import { DiscordAPIError, RESTJSONErrorCodes } from 'discord.js';
import { sweepDepartures } from '../../src/functions/departures/sweepDepartures.js';

/** A guild where the named ids are gone and everyone else is still present. */
function fakeSweepGuild(departedIds: string[], send = vi.fn(async () => undefined)) {
  const thread = { id: 'THREAD', isTextBased: () => true, send };
  return {
    id: 'guild',
    channels: { cache: new Map([['THREAD', thread]]), fetch: async () => thread },
    client: { users: { fetch: async (id: string) => ({ tag: `tag-${id}` }) } },
    members: {
      fetch: async (id: string) => {
        if (departedIds.includes(id)) {
          throw new DiscordAPIError(
            { code: RESTJSONErrorCodes.UnknownMember, message: 'Unknown Member' } as never,
            RESTJSONErrorCodes.UnknownMember as never,
            404,
            'GET',
            '',
            {},
          );
        }
        return { id };
      },
    },
  } as never;
}

describe('sweepDepartures — the trials pass', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createTables(getDatabase(':memory:'));
  });
  afterEach(() => closeDatabase());

  it('notifies for an active trial whose user is gone, and stamps it', async () => {
    const trialId = seedTrial({ userId: 'gone' });

    const result = await sweepDepartures(fakeSweepGuild(['gone']));

    expect(result.trials).toEqual({ checked: 1, notified: 1, unresolved: 0 });
    const row = getDatabase().prepare('SELECT departed_notified_at FROM trials WHERE id = ?').get(trialId) as { departed_notified_at: string | null };
    expect(row.departed_notified_at).not.toBeNull();
  });

  it('leaves a trial alone when its user is still in the guild', async () => {
    seedTrial({ userId: 'present' });

    const result = await sweepDepartures(fakeSweepGuild([]));

    expect(result.trials).toEqual({ checked: 1, notified: 0, unresolved: 0 });
  });

  it('does not check a trial with no linked Discord user at all', async () => {
    seedTrial({ userId: null });

    const result = await sweepDepartures(fakeSweepGuild(['gone']));

    expect(result.trials.checked).toBe(0);
  });

  it('does not re-check a trial already notified about', async () => {
    seedTrial({ userId: 'gone', notifiedAt: '2026-08-10 10:00:00' });

    const result = await sweepDepartures(fakeSweepGuild(['gone']));

    expect(result.trials).toEqual({ checked: 0, notified: 0, unresolved: 0 });
  });

  it('reports the two subjects separately', async () => {
    const result = await sweepDepartures(fakeSweepGuild([]));

    expect(result).toEqual({
      applications: { checked: 0, notified: 0, unresolved: 0 },
      trials: { checked: 0, notified: 0, unresolved: 0 },
    });
  });
});
```

Note: this block must **not** carry the `vi.mock` of `notifyTrialDeparture` from Task 4 — the sweep tests exercise the real notifier. If the Task 4 mock is file-scoped and interferes, move the handler tests into their own file `tests/unit/trialDepartureHandler.test.ts` with the mocks, and keep this file mock-free apart from `auditLog` and `overlords`.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/trialDeparture.test.ts`
Expected: FAIL — `sweepDepartures` is not exported (the moved file still exports `sweepDepartedApplicants`).

- [ ] **Step 4: Rewrite the sweep with two passes**

In `src/functions/departures/sweepDepartures.ts`, keep `membershipOf` and its comment exactly as they are — the `departed` / `unknown` distinction is the point of the whole file. Replace the exported function with:

```typescript
export interface DeparturesSweepResult {
  applications: DepartureSweepResult;
  trials: DepartureSweepResult;
}

/**
 * Catch up on applicants and trials who left while this process was not running.
 *
 * The gateway only delivers `guildMemberRemove` to a connected client, and every
 * deploy restarts this bot — so without this sweep those departures are lost
 * silently. Two passes over two tables, sharing one membership check, because the
 * expensive part is asking Discord and the answer is the same question either way.
 *
 * Never throws: a failure here must not stop startup.
 */
export async function sweepDepartures(guild: Guild): Promise<DeparturesSweepResult> {
  return {
    applications: await sweepApplications(guild),
    trials: await sweepTrials(guild),
  };
}
```

Rename the existing exported function to `async function sweepApplications(guild: Guild): Promise<DepartureSweepResult>` (no longer exported), leaving its body untouched, and add its trial twin:

```typescript
async function sweepTrials(guild: Guild): Promise<DepartureSweepResult> {
  const result: DepartureSweepResult = { checked: 0, notified: 0, unresolved: 0 };

  try {
    // A NULL discord_user_id is not a candidate: nobody linked this trial, so there
    // is no membership to check and nothing to report.
    const pending = getDatabase()
      .prepare(
        `SELECT id, character_name, discord_user_id FROM trials
          WHERE status = 'active'
            AND discord_user_id IS NOT NULL
            AND departed_notified_at IS NULL
          ORDER BY id`,
      )
      .all() as { id: number; character_name: string; discord_user_id: string }[];

    for (const trial of pending) {
      result.checked += 1;

      const membership = await membershipOf(guild, trial.discord_user_id);
      if (membership === 'present') continue;
      if (membership === 'unknown') {
        result.unresolved += 1;
        continue;
      }

      // They have left, so their tag is no longer available from the guild. The
      // copy uses the trial's character name, so the tag is only for the log line.
      const user = await guild.client.users.fetch(trial.discord_user_id).catch(() => null);
      const outcome = await notifyTrialDeparture(guild, {
        userId: trial.discord_user_id,
        tag: user?.tag ?? trial.discord_user_id,
      });
      if (outcome === 'notified') result.notified += 1;
    }
  } catch (error) {
    logger.error(
      'Trials',
      `Trial departure sweep failed: ${error}`,
      error instanceof Error ? error : undefined,
    );
  }

  return result;
}
```

Add the import: `import { notifyTrialDeparture } from '../trial-review/notifyTrialDeparture.js';`

- [ ] **Step 5: Update `ready.ts`**

Import path and call:

```typescript
import { sweepDepartures } from '../functions/departures/sweepDepartures.js';
```

```typescript
    const departures = guild
      ? await sweepDepartures(guild)
      : {
          applications: { checked: 0, notified: 0, unresolved: 0 },
          trials: { checked: 0, notified: 0, unresolved: 0 },
        };
```

And the startup line's departures segment — both subjects, so "nothing to check" stays distinguishable from "checked, none departed":

```typescript
        `departures: apps ${departures.applications.notified}/${departures.applications.checked}, ` +
        `trials ${departures.trials.notified}/${departures.trials.checked}` +
        (departures.applications.unresolved + departures.trials.unresolved > 0
          ? ` (${departures.applications.unresolved + departures.trials.unresolved} unresolved)`
          : ''),
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/trialDeparture.test.ts tests/unit/applicantDeparture.test.ts`
Expected: PASS. The applicant sweep tests now call `sweepDepartures(...)` and read `result.applications` — update their assertions to the nested shape, keeping the numbers identical.

- [ ] **Step 7: Typecheck and run the whole suite**

Run: `npx tsc --noEmit` then `npm test` (with env stubs). Also `grep -rn "sweepDepartedApplicants" src tests` and expect no hits.
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(trials): one boot sweep covering applicant and trial departures"
```

---

### Task 6: Officers name the trial's Discord user

**Files:**
- Modify: `src/functions/trial-review/createTrialReviewThread.ts` (`TrialData` ~line 20, the INSERT ~line 148)
- Modify: `src/commands/trials.ts` (`create_thread` ~line 38, `change_trial_info` ~line 51, its dispatch ~line 194)
- Modify: `src/interactions/trial.ts` (`create_thread` modal build ~line 85, `modalCreate` ~line 131)
- Modify: `src/functions/trial-review/changeTrialInfo.ts` (`TrialInfoUpdates` ~line 14, the UPDATE ~line 43)
- Test: `tests/unit/trialDepartureLinking.test.ts` (create)

**Interfaces:**
- Consumes: `trials.discord_user_id` from Task 1.
- Produces: `TrialData.discordUserId?: string`; `TrialInfoUpdates.discordUserId?: string`; `createTrialReviewThread` stores the id, falling back to a `raiders` lookup by character name.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/trialDepartureLinking.test.ts`, alongside `tests/unit/applicantDeparture.test.ts` (flat, not under `tests/unit/trial-review/`, which holds only `trialForumTags.test.ts`). `createTrialReviewThread` needs a Discord client, so test the resolver directly rather than mocking a client — the in-memory database idiom is the one from Task 3.

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { closeDatabase, getDatabase } from '../../src/database/db.js';
import { createTables } from '../../src/database/schema.js';
import { resolveTrialDiscordUserId } from '../../src/functions/trial-review/createTrialReviewThread.js';

describe('resolveTrialDiscordUserId', () => {
  beforeEach(() => createTables(getDatabase(':memory:')));
  afterEach(() => closeDatabase());

  it('prefers the id the officer picked', () => {
    getDatabase()
      .prepare("INSERT INTO raiders (character_name, discord_user_id) VALUES ('Brentpriest', 'u-raider')")
      .run();

    expect(resolveTrialDiscordUserId('Brentpriest', 'u-picked')).toBe('u-picked');
  });

  it('falls back to the raiders row when the officer picked nobody', () => {
    getDatabase()
      .prepare("INSERT INTO raiders (character_name, discord_user_id) VALUES ('Brentpriest', 'u-raider')")
      .run();

    expect(resolveTrialDiscordUserId('Brentpriest', undefined)).toBe('u-raider');
  });

  it('returns null when the character is not a known raider — the common case for a new trial', () => {
    expect(resolveTrialDiscordUserId('Stranger', undefined)).toBeNull();
  });

  it('ignores a raiders row that has no linked Discord account', () => {
    getDatabase()
      .prepare("INSERT INTO raiders (character_name, discord_user_id) VALUES ('Unlinked', NULL)")
      .run();

    expect(resolveTrialDiscordUserId('Unlinked', undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/trialDepartureLinking.test.ts`
Expected: FAIL — `resolveTrialDiscordUserId` is not exported.

- [ ] **Step 3: Add the resolver and store the id**

In `src/functions/trial-review/createTrialReviewThread.ts`:

```typescript
export interface TrialData {
  characterName: string;
  role: string;
  startDate: string;
  applicationId?: number;
  /** Whose Discord account this trial is, when the officer named them. */
  discordUserId?: string;
}

/**
 * Whose Discord account a new trial belongs to.
 *
 * The officer's pick wins outright. The `raiders` lookup is only a fallback and is
 * expected to miss: a manually created trial is precisely the case where the
 * character has not been through a wowaudit sync yet, which is why the command
 * offers a user picker at all. Null means departure notifications stay off for this
 * trial until someone links it.
 */
export function resolveTrialDiscordUserId(
  characterName: string,
  picked: string | undefined,
): string | null {
  if (picked) return picked;

  const raider = getDatabase()
    .prepare(
      'SELECT discord_user_id FROM raiders WHERE character_name = ? AND discord_user_id IS NOT NULL',
    )
    .get(characterName) as { discord_user_id: string } | undefined;

  return raider?.discord_user_id ?? null;
}
```

Then in `createTrialReviewThread`, destructure `discordUserId` alongside the rest and widen the INSERT:

```typescript
  const { characterName, role, startDate, applicationId, discordUserId } = trialData;
```

```typescript
  const result = db
    .prepare(
      `INSERT INTO trials (character_name, role, start_date, application_id, status, discord_user_id)
       VALUES (?, ?, ?, ?, 'active', ?)`,
    )
    .run(
      characterName,
      role,
      startDate,
      applicationId ?? null,
      resolveTrialDiscordUserId(characterName, discordUserId),
    );
```

- [ ] **Step 4: Pass the applicant's id through when an application is accepted**

Find the `createTrialReviewThread` call in `src/functions/applications/acceptApplication.ts` (`grep -n "createTrialReviewThread(" src/functions/applications/acceptApplication.ts`) and add `discordUserId: application.applicant_user_id` to the object it passes. The `application` row is already in scope there.

- [ ] **Step 5: Add the USER option to both subcommands**

In `src/commands/trials.ts`, `create_thread` gains an option, so it can no longer be the bare one-liner:

```typescript
    .addSubcommand((sub) =>
      sub
        .setName('create_thread')
        .setDescription('Create a new trial review thread')
        .addUserOption((opt) =>
          opt
            .setName('discord_user')
            .setDescription("The trial's Discord account (enables departure notifications)"),
        ),
    )
```

and `change_trial_info` gains the same option after `start_date`:

```typescript
        .addUserOption((opt) =>
          opt.setName('discord_user').setDescription("Link or correct the trial's Discord account"),
        ),
```

- [ ] **Step 6: Carry the picked user through the modal**

In `src/commands/trials.ts`, the `create_thread` case reads the option and puts it in the modal's customId — the same mechanism `trial:modal:update:<id>` already uses, because a modal itself can only hold text fields:

```typescript
      case 'create_thread': {
        const today = new Date().toISOString().split('T')[0];
        const discordUser = interaction.options.getUser('discord_user');

        const modal = new ModalBuilder()
          .setCustomId(discordUser ? `trial:modal:create:${discordUser.id}` : 'trial:modal:create')
          .setTitle('Create Trial Review');
```

In `src/interactions/trial.ts`, `modalCreate` reads it from its params and reports coverage either way:

```typescript
async function modalCreate(interaction: ModalSubmitInteraction, params: string[]): Promise<void> {
  const characterName = interaction.fields.getTextInputValue('character_name');
  const role = interaction.fields.getTextInputValue('role');
  const startDate = interaction.fields.getTextInputValue('start_date');
  // Empty when the officer picked nobody; createTrialReviewThread then tries raiders.
  const discordUserId = params[0] || undefined;
```

```typescript
    const trial = await createTrialReviewThread(interaction.client, {
      characterName,
      role,
      startDate,
      discordUserId,
    });
```

and the success reply states coverage — plainly, either way, because with the picker as the main route silence would leave the common case ambiguous:

```typescript
    const linked = trial.discord_user_id
      ? `Departure notifications are on (<@${trial.discord_user_id}>).`
      : 'Departure notifications are **off** — no Discord account linked. Set one with `/trials change_trial_info discord_user:`.';
    await interaction.editReply({
      content: `Trial created for **${characterName}**. Thread: <#${trial.thread_id}>\n${linked}`,
    });
```

`createTrialReviewThread` ends with `SELECT * FROM trials WHERE id = ?` (`createTrialReviewThread.ts:208`) and returns that row, so `trial.discord_user_id` is already populated by the time the reply is built — no extra query needed.

- [ ] **Step 7: Accept the field in `changeTrialInfo`**

In `src/functions/trial-review/changeTrialInfo.ts`:

```typescript
export interface TrialInfoUpdates {
  characterName?: string;
  role?: string;
  startDate?: string;
  discordUserId?: string;
}
```

```typescript
  const newDiscordUserId = updates.discordUserId ?? trial.discord_user_id;

  db.prepare(
    'UPDATE trials SET character_name = ?, role = ?, start_date = ?, discord_user_id = ? WHERE id = ?',
  ).run(newCharName, newRole, newStartDate, newDiscordUserId, trialId);
```

Then in `src/commands/trials.ts`'s `change_trial_info` case, read the option, include it in the "at least one field" guard, and pass it on:

```typescript
        const discordUserId = interaction.options.getUser('discord_user')?.id ?? undefined;

        if (!characterName && !role && !startDate && !discordUserId) {
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/trialDepartureLinking.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 9: Typecheck and run the whole suite**

Run: `npx tsc --noEmit` then `npm test` (with env stubs).
Expected: clean. An e2e or unit test asserting the old create-trial reply text may fail — update it to the new two-line reply.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(trials): let officers link a trial's Discord account"
```

---

### Task 7: Documentation and the full gate

**Files:**
- Modify: `docs/database.md` (the trials table)
- Modify: `docs/commands.md` (the `/trials` entries)
- Modify: `.claude/skills/database.md` and `.claude/skills/commands.md` **only if** they document the same details (check first with `grep -n "trials" .claude/skills/*.md`)

**Interfaces:** none.

- [ ] **Step 1: Find what the docs claim today**

Run: `grep -n "trials" docs/database.md docs/commands.md | head -30` and `grep -n "schema version\|v12\|version 12" docs/database.md`

- [ ] **Step 2: Update the trials table documentation**

Add `discord_user_id TEXT` and `departed_notified_at TEXT` to the trials table's column list in `docs/database.md`, with one line each on what they mean, and bump any stated head schema version from 12 to 13. Follow how v12's `applications.departed_notified_at` is documented, and match it.

- [ ] **Step 3: Update the command documentation**

In `docs/commands.md`, record the new `discord_user` option on `/trials create_thread` and `/trials change_trial_info`, and that a trial with no linked account gets no departure notification.

- [ ] **Step 4: Run the full local gate**

```bash
npx tsc --noEmit
npm run lint
npm test          # with the env stubs from Global Constraints
npm run build
```
Expected: all clean, and the test count up by roughly 30 on the pre-change figure.

- [ ] **Step 5: Check formatting the way that actually works here**

```bash
for f in $(git diff --name-only origin/main); do
  npx prettier "$f" | diff -q --strip-trailing-cr - "$f" >/dev/null 2>&1 && echo "OK $f" || echo "DIFF $f"
done
```
Any `DIFF` is a real formatting problem: fix it with `npx prettier --write <file>`. (`npm run format:check` reports every file in the repo as unformatted because the checkout is CRLF — ignore it.)

- [ ] **Step 6: Commit and open the PR**

```bash
git add -A
git commit -m "docs(trials): record schema v13 and the discord_user option"
git push -u origin feat/trial-departure-notification
```

Open a PR into `main` whose **title** is the conventional-commit line you want in history (the repo is squash-only, so the title becomes the commit subject):

`feat(trials): notify overlords when a trial leaves the Discord`

The body should state: the schema v13 columns and what the back-fill resolves; that the notification is notify-only; that the live path and the boot sweep share `notifyTrialDeparture`; the new `discord_user` option on both subcommands; and the verification actually run (test counts, tsc, lint, build, and that the e2e suite is not part of `npm test`). Then wait for `ci` — a run can take minutes to be created and an absent check means *not ready*, never done.

---

## Manual verification, after the test deploy

Not part of the plan's tasks — record the results on the PR or a follow-up issue. Seeded data can exercise this exactly as it did for applicants:

1. `/trials create_thread` with `discord_user` set to any account, and confirm the reply says notifications are on.
2. Point that trial's `discord_user_id` at a well-formed snowflake that is not a guild member (`100000000000000001` answers 10013 Unknown User, which the sweep counts as departed).
3. Restart the bot. Expect `departures: apps 0/0, trials 1/1` and one pinged message in the trial post plus an unpinged audit mirror.
4. Restart again. Expect `trials 0/0` — a stamped row is not re-checked — and no second message.
5. Confirm the trial's review alerts are untouched and its status is still `active`.

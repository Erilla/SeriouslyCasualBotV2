# Detailed Bot-Audit Log Messages — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make entity-related bot-audit log messages say *who* the action was about and link (without pinging) to the relevant Discord user and post/thread.

**Architecture:** A new pure formatter module (`src/services/auditRefs.ts`) produces the enriched detail strings; `audit()` gains `allowedMentions: { parse: [] }` so `<@id>` renders as a non-pinging chip; each entity call site is rewired to use the formatters.

**Tech Stack:** TypeScript (ESM, Node16 module resolution — imports use `.js` extension), discord.js v14, better-sqlite3, Vitest.

## Global Constraints

- ESM with Node16 resolution: **all relative imports end in `.js`** even for `.ts` sources.
- Discord timestamps use the long-date style `<t:UNIX:D>` (static full date, localised per viewer) — never the relative `:R` style.
- Mentions in audit messages must never notify anyone.
- Tests are Vitest; run with `npm test` (the `default` project). Typecheck with `npm run typecheck`. Lint with `npm run lint`.
- Config is eagerly validated on import, so unit tests that import modules pulling in `../config.js` must `vi.mock('../../src/config.js', ...)`.

---

### Task 1: `auditRefs` formatter module

**Files:**
- Create: `src/services/auditRefs.ts`
- Test: `tests/unit/auditRefs.test.ts`

**Interfaces:**
- Consumes: `TrialRow`, `ApplicationRow` from `src/types/index.ts`.
- Produces:
  - `trialRef(trial: Pick<TrialRow, 'character_name' | 'id' | 'thread_id'>): string`
  - `applicationRef(app: Pick<ApplicationRow, 'character_name' | 'applicant_user_id' | 'thread_id' | 'forum_post_id'>): string`
  - `dateRef(date: string): string`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/auditRefs.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { trialRef, applicationRef, dateRef } from '../../src/services/auditRefs.js';

describe('trialRef', () => {
  it('includes name, id, and a thread link when thread_id is set', () => {
    expect(trialRef({ character_name: 'Sploboss', id: 3, thread_id: '123' })).toBe(
      '**Sploboss** (#3) — <#123>',
    );
  });

  it('omits the thread link when thread_id is null', () => {
    expect(trialRef({ character_name: 'Sploboss', id: 3, thread_id: null })).toBe(
      '**Sploboss** (#3)',
    );
  });
});

describe('applicationRef', () => {
  it('links the applicant and prefers forum_post_id for the post link', () => {
    expect(
      applicationRef({
        character_name: 'Sploboss',
        applicant_user_id: '456',
        thread_id: '999',
        forum_post_id: '789',
      }),
    ).toBe('**Sploboss** (<@456>) — <#789>');
  });

  it('falls back to thread_id when forum_post_id is null', () => {
    expect(
      applicationRef({
        character_name: 'Sploboss',
        applicant_user_id: '456',
        thread_id: '999',
        forum_post_id: null,
      }),
    ).toBe('**Sploboss** (<@456>) — <#999>');
  });

  it('omits the post link when both post ids are null', () => {
    expect(
      applicationRef({
        character_name: 'Sploboss',
        applicant_user_id: '456',
        thread_id: null,
        forum_post_id: null,
      }),
    ).toBe('**Sploboss** (<@456>)');
  });

  it('shows Unknown when character_name is null', () => {
    expect(
      applicationRef({
        character_name: null,
        applicant_user_id: '456',
        thread_id: null,
        forum_post_id: null,
      }),
    ).toBe('**Unknown** (<@456>)');
  });
});

describe('dateRef', () => {
  it('renders a YYYY-MM-DD date as a long-date Discord timestamp', () => {
    // 2026-04-20 UTC midnight = 1776643200 seconds
    expect(dateRef('2026-04-20')).toBe('<t:1776643200:D>');
  });

  it('returns the raw string when the date is unparseable', () => {
    expect(dateRef('not-a-date')).toBe('not-a-date');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/auditRefs.test.ts`
Expected: FAIL — cannot resolve `../../src/services/auditRefs.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/services/auditRefs.ts`:

```ts
import type { TrialRow, ApplicationRow } from '../types/index.js';

/** `**Name** (#id)`, plus ` — <#thread_id>` when the review thread exists. */
export function trialRef(trial: Pick<TrialRow, 'character_name' | 'id' | 'thread_id'>): string {
  const base = `**${trial.character_name}** (#${trial.id})`;
  return trial.thread_id ? `${base} — <#${trial.thread_id}>` : base;
}

/**
 * `**Name** (<@applicant>)`, plus ` — <#post>` when a forum post/thread exists.
 * Prefers `forum_post_id`, falling back to `thread_id`.
 */
export function applicationRef(
  app: Pick<ApplicationRow, 'character_name' | 'applicant_user_id' | 'thread_id' | 'forum_post_id'>,
): string {
  const name = app.character_name ?? 'Unknown';
  const base = `**${name}** (<@${app.applicant_user_id}>)`;
  const postId = app.forum_post_id ?? app.thread_id;
  return postId ? `${base} — <#${postId}>` : base;
}

/**
 * Render a `YYYY-MM-DD` string as a Discord long-date timestamp (static full
 * date, localised to each viewer). Falls back to the raw string if unparseable.
 */
export function dateRef(date: string): string {
  const ms = Date.parse(date);
  if (Number.isNaN(ms)) return date;
  return `<t:${Math.floor(ms / 1000)}:D>`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/auditRefs.test.ts`
Expected: PASS (all 8 assertions).

- [ ] **Step 5: Commit**

```bash
git add src/services/auditRefs.ts tests/unit/auditRefs.test.ts
git commit -m "feat(audit): add auditRefs formatters for trials, applications, dates"
```

---

### Task 2: Suppress pings in `audit()`

**Files:**
- Modify: `src/services/auditLog.ts:18`
- Test: `tests/unit/auditLog.test.ts` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: `audit()` behaviour unchanged except the `send` call now passes `allowedMentions: { parse: [] }`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/auditLog.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/config.js', () => ({ config: { officerRoleId: 'role-1' } }));
vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { audit, setAuditChannel } from '../../src/services/auditLog.js';

describe('audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends with mentions suppressed so linked users are not pinged', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    // Cast through unknown — the test channel only needs `send`.
    setAuditChannel({ send } as unknown as Parameters<typeof setAuditChannel>[0]);

    const officer = { displayName: 'Splo' } as Parameters<typeof audit>[0];
    await audit(officer, 'rejected application', '**Sploboss** (<@456>)');

    expect(send).toHaveBeenCalledTimes(1);
    const arg = send.mock.calls[0][0];
    expect(arg.content).toBe('**Splo** rejected application: **Sploboss** (<@456>)');
    expect(arg.allowedMentions).toEqual({ parse: [] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/auditLog.test.ts`
Expected: FAIL — `arg.allowedMentions` is `undefined`, not `{ parse: [] }`.

- [ ] **Step 3: Write minimal implementation**

In `src/services/auditLog.ts`, change the `audit()` send call (line 18):

```ts
    await auditChannel.send({ content: message, allowedMentions: { parse: [] } });
```

Leave `alertOfficers()` untouched — it keeps its own `allowedMentions: { roles: [roleId] }`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/auditLog.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/auditLog.ts tests/unit/auditLog.test.ts
git commit -m "fix(audit): suppress mention pings in audit channel posts"
```

---

### Task 3: Enrich trial audit call sites

**Files:**
- Modify: `src/interactions/trial.ts` (handlers `extend`, `markPromote`, `close`, `modalCreate`, `modalUpdate`)
- Modify: `src/commands/trials.ts` (cases `remove_trial`, `change_trial_info`)

**Interfaces:**
- Consumes: `trialRef`, `dateRef` from `src/services/auditRefs.js`.
- Produces: no new exports.

- [ ] **Step 1: Add the import to `src/interactions/trial.ts`**

After the existing `import { audit } from '../services/auditLog.js';` line, add:

```ts
import { trialRef } from '../services/auditRefs.js';
```

(`getDatabase` and the `TrialRow` type are already imported in this file.)

- [ ] **Step 2: Rewrite the three button handlers to fetch the row and use `trialRef`**

Replace the bodies of `extend`, `markPromote`, and `close` so each captures the trial row before acting. New `extend`:

```ts
async function extend(interaction: ButtonInteraction, params: string[]): Promise<void> {
  const trialId = parseInt(params[0], 10);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const trial = getDatabase().prepare('SELECT * FROM trials WHERE id = ?').get(trialId) as
    | TrialRow
    | undefined;

  try {
    await extendTrial(interaction.client, trialId);
    await audit(interaction.user, 'extended trial', trial ? trialRef(trial) : `#${trialId}`);
    await interaction.editReply({ content: 'Trial extended by 1 week.' });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    await interaction.editReply({ content: `Failed to extend trial: ${error.message}` });
  }
}
```

New `markPromote`:

```ts
async function markPromote(interaction: ButtonInteraction, params: string[]): Promise<void> {
  const trialId = parseInt(params[0], 10);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const trial = getDatabase().prepare('SELECT * FROM trials WHERE id = ?').get(trialId) as
    | TrialRow
    | undefined;

  try {
    await markForPromotion(interaction.client, trialId);
    await audit(
      interaction.user,
      'marked trial for promotion',
      trial ? trialRef(trial) : `#${trialId}`,
    );
    await interaction.editReply({ content: 'Trial marked for promotion.' });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    await interaction.editReply({ content: `Failed: ${error.message}` });
  }
}
```

New `close`:

```ts
async function close(interaction: ButtonInteraction, params: string[]): Promise<void> {
  const trialId = parseInt(params[0], 10);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const trial = getDatabase().prepare('SELECT * FROM trials WHERE id = ?').get(trialId) as
    | TrialRow
    | undefined;

  try {
    await closeTrial(interaction.client, trialId);
    await audit(interaction.user, 'closed trial', trial ? trialRef(trial) : `#${trialId}`);
    await interaction.editReply({ content: 'Trial closed.' });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    await interaction.editReply({ content: `Failed to close trial: ${error.message}` });
  }
}
```

- [ ] **Step 3: Update `modalCreate` and `modalUpdate` in `src/interactions/trial.ts`**

In `modalCreate`, replace the audit line:

```ts
    await audit(interaction.user, 'created trial', `${characterName} as ${role} (#${trial.id})`);
```

with (name bold, role backticked, thread link when present):

```ts
    const createdDetail = `**${characterName}** (#${trial.id}) as \`${role}\`${
      trial.thread_id ? ` — <#${trial.thread_id}>` : ''
    }`;
    await audit(interaction.user, 'created trial', createdDetail);
```

In `modalUpdate`, replace the audit call:

```ts
    await audit(
      interaction.user,
      'updated trial info via modal',
      `${trial.character_name} (#${trialId})`,
    );
```

with:

```ts
    await audit(interaction.user, 'updated trial info via modal', trialRef(trial));
```

- [ ] **Step 4: Update `src/commands/trials.ts`**

Add the import after the existing `audit` import:

```ts
import { trialRef, dateRef } from '../services/auditRefs.js';
```

In the `remove_trial` case, replace:

```ts
          await audit(interaction.user, 'closed trial', `${trial.character_name} (#${trial.id})`);
```

with:

```ts
          await audit(interaction.user, 'closed trial', trialRef(trial));
```

In the `change_trial_info` case, replace the changes-list build and audit call:

```ts
          const changes = [];
          if (characterName) changes.push(`name=${characterName}`);
          if (role) changes.push(`role=${role}`);
          if (startDate) changes.push(`start_date=${startDate}`);

          await audit(
            interaction.user,
            'updated trial info',
            `${trial.character_name} (#${trial.id}): ${changes.join(', ')}`,
          );
```

with (role backticked, date as timestamp, prefix via `trialRef`):

```ts
          const changes = [];
          if (characterName) changes.push(`name=${characterName}`);
          if (role) changes.push(`role=\`${role}\``);
          if (startDate) changes.push(`start_date=${dateRef(startDate)}`);

          await audit(
            interaction.user,
            'updated trial info',
            `${trialRef(trial)}: ${changes.join(', ')}`,
          );
```

- [ ] **Step 5: Typecheck, lint, and run the suite**

Run: `npm run typecheck && npm run lint && npm test`
Expected: typecheck clean, lint clean, all existing tests PASS (no regressions).

- [ ] **Step 6: Commit**

```bash
git add src/interactions/trial.ts src/commands/trials.ts
git commit -m "feat(audit): enrich trial audit logs with name, thread link, and dates"
```

---

### Task 4: Enrich application audit call sites

**Files:**
- Modify: `src/functions/applications/rejectApplication.ts:201`
- Modify: `src/functions/applications/acceptApplication.ts:244-248`

**Interfaces:**
- Consumes: `applicationRef`, `dateRef` from `src/services/auditRefs.js`.
- Produces: no new exports.

- [ ] **Step 1: Update `rejectApplication.ts`**

Add the import after the existing `audit` import:

```ts
import { applicationRef } from '../../services/auditRefs.js';
```

Replace the audit call:

```ts
  // Audit log
  await audit(interaction.user, 'rejected application', characterName);
```

with:

```ts
  // Audit log
  await audit(interaction.user, 'rejected application', applicationRef(application));
```

(`application` is the DB row fetched at the top of `processRejectModal`; its `character_name` may be null, in which case `applicationRef` shows `Unknown` — matching the existing `characterName` fallback.)

- [ ] **Step 2: Update `acceptApplication.ts`**

Add the import after the existing `audit` import:

```ts
import { applicationRef, dateRef } from '../../services/auditRefs.js';
```

Replace the audit call:

```ts
  // Audit log
  await audit(
    interaction.user,
    'accepted application',
    `${characterName} as ${role} starting ${startDate}`,
  );
```

with (using the modal-entered `characterName`, applicant/post from the row, backticked role, timestamped date):

```ts
  // Audit log
  const acceptRef = applicationRef({
    character_name: characterName,
    applicant_user_id: application.applicant_user_id,
    thread_id: application.thread_id,
    forum_post_id: application.forum_post_id,
  });
  await audit(
    interaction.user,
    'accepted application',
    `${acceptRef} as \`${role}\` starting ${dateRef(startDate)}`,
  );
```

- [ ] **Step 3: Typecheck, lint, and run the suite**

Run: `npm run typecheck && npm run lint && npm test`
Expected: typecheck clean, lint clean, all existing tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/functions/applications/rejectApplication.ts src/functions/applications/acceptApplication.ts
git commit -m "feat(audit): link applicant and post in application audit logs"
```

---

### Task 5: Enrich raider/overlord audit call sites

**Files:**
- Modify: `src/commands/raiders.ts` (cases `update_raider_user`, `add_overlord`, `remove_overlord`)

**Interfaces:**
- Consumes: `getOverlords` (already imported in `raiders.ts`).
- Produces: no new exports.

- [ ] **Step 1: Update `update_raider_user` (linked raider)**

Replace:

```ts
          await audit(interaction.user, 'linked raider', `${characterName} -> ${user.tag}`);
```

with (clickable, non-pinging user link):

```ts
          await audit(interaction.user, 'linked raider', `${characterName} → <@${user.id}>`);
```

- [ ] **Step 2: Update `add_overlord`**

Replace:

```ts
          await audit(interaction.user, 'added overlord', `${name} (${user.tag})`);
```

with:

```ts
          await audit(interaction.user, 'added overlord', `${name} (<@${user.id}>)`);
```

- [ ] **Step 3: Update `remove_overlord` to look up the user id before removal**

Replace:

```ts
        try {
          removeOverlord(name);
          await audit(interaction.user, 'removed overlord', name);
```

with (capture the overlord's user id before it is deleted so the log can link it):

```ts
        try {
          const overlord = getOverlords().find((o) => o.name === name);
          removeOverlord(name);
          await audit(
            interaction.user,
            'removed overlord',
            overlord ? `${name} (<@${overlord.user_id}>)` : name,
          );
```

- [ ] **Step 4: Typecheck, lint, and run the suite**

Run: `npm run typecheck && npm run lint && npm test`
Expected: typecheck clean, lint clean, all existing tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/raiders.ts
git commit -m "feat(audit): link users in raider-link and overlord audit logs"
```

---

## Final verification

- [ ] **Full suite green:** `npm run typecheck && npm run lint && npm test` — all clean.
- [ ] **Behavioural check:** Use the `verify` skill (or the test bot on `develop`) to exercise a trial close via the review-thread button and an application rejection, confirming the audit channel now shows the character name, a clickable user/post link, and that **no ping notification** fires. (Note from project memory: pushing to `develop` restarts the test bot and kills in-flight commands — don't push mid-run.)

## Notes on scope (left unchanged, per spec)

- Ignored-character logs (`raiders.ts` ignore/remove-ignore, `raider.ts` ignore) — name only; nothing to link.
- `raider.ts` `confirmLink` / `selectUser` already emit `<@userId>`; they gain non-pinging behaviour for free via Task 2.
- Config-type actions (log level, settings, setup, guildinfo, migrate) — already self-explanatory.

# interactionCreate.ts Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `src/events/interactionCreate.ts` (691 lines, 23 handlers) into a thin dispatcher plus per-domain handler modules, sharing middleware for officer-role gating and error wrapping. No behavior change, no customId string changes.

**Architecture:** New `src/interactions/` directory contains `registry.ts` (handler types, dispatcher, three arrays), `middleware.ts` (`requireOfficer`, `wrapErrors`), and one domain module per area (pagination, loot, raider, trial, application). `interactionCreate.ts` shrinks to a thin dispatcher that looks up handlers by `customId` prefix, runs middleware, and calls the handler.

**Tech Stack:** TypeScript, discord.js v14, vitest, Node16 module resolution.

**Spec:** `docs/superpowers/specs/2026-04-19-interactioncreate-refactor-design.md`

**Migration strategy:** Dual-dispatch during migration. Task 2 adds the new dispatcher in front of the existing if-cascade; with an empty registry it's a no-op. Tasks 3–7 migrate one domain at a time — each task adds the domain's handlers to the registry and removes its if-blocks from the cascade. Task 8 removes the now-empty cascade and dual-dispatch scaffold. At every task boundary, `npm test` passes.

---

## File plan

| File | Role | Tasks |
|---|---|---|
| `src/interactions/registry.ts` | Handler types, `dispatch()` function, exported registry arrays | 1 (empty), 3–7 (populate) |
| `src/interactions/middleware.ts` | `requireOfficer`, `wrapErrors` | 1 |
| `src/interactions/pagination.ts` | Pagination button handler | 3 |
| `src/interactions/loot.ts` | Loot priority button handler | 4 |
| `src/interactions/raider.ts` | Raider link/ignore buttons + user select | 5 |
| `src/interactions/trial.ts` | Trial officer buttons + trial modals | 6 |
| `src/interactions/application.ts` | Application buttons + application modals | 7 |
| `src/events/interactionCreate.ts` | Thin dispatcher (~60 lines after task 8) | 2, 3–7 (trim), 8 (final cleanup) |
| `tests/unit/interactions/middleware.test.ts` | Tests for `requireOfficer`, `wrapErrors` | 1 |
| `tests/unit/interactions/dispatch.test.ts` | Tests for the `dispatch` function | 1 |
| `tests/unit/interactions/registry.test.ts` | Prefix-collision test across populated registries | 9 |

---

## Task 1: Infrastructure — types, middleware, and dispatch function

Create the new `src/interactions/` directory with the handler types, middleware, and dispatch helper. Registry arrays are empty. No integration yet.

**Files:**
- Create: `src/interactions/registry.ts`
- Create: `src/interactions/middleware.ts`
- Create: `tests/unit/interactions/middleware.test.ts`
- Create: `tests/unit/interactions/dispatch.test.ts`

### Step 1.1: Write the failing middleware tests

- [ ] Create `tests/unit/interactions/middleware.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import type { ButtonInteraction } from 'discord.js';
import { requireOfficer, wrapErrors } from '../../../src/interactions/middleware.js';

// Stub the config import so the test doesn't need a real env
vi.mock('../../../src/config.js', () => ({
  config: { officerRoleId: 'OFFICER' },
}));

// Stub the logger so we can assert on calls
vi.mock('../../../src/services/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

function stubInteraction(opts: {
  hasRole?: boolean;
  replied?: boolean;
  deferred?: boolean;
} = {}) {
  return {
    member: { roles: { cache: { has: (id: string) => opts.hasRole === true && id === 'OFFICER' } } },
    replied: opts.replied ?? false,
    deferred: opts.deferred ?? false,
    reply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
  } as unknown as ButtonInteraction;
}

describe('requireOfficer', () => {
  it('returns true when the member has the officer role', async () => {
    const interaction = stubInteraction({ hasRole: true });
    const allowed = await requireOfficer(interaction, 'button');
    expect(allowed).toBe(true);
    expect((interaction as any).reply).not.toHaveBeenCalled();
  });

  it('returns false and replies ephemeral when the member lacks the role', async () => {
    const interaction = stubInteraction({ hasRole: false });
    const allowed = await requireOfficer(interaction, 'button');
    expect(allowed).toBe(false);
    expect((interaction as any).reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringMatching(/permission/i) }),
    );
  });
});

describe('wrapErrors', () => {
  it('runs the function when it succeeds', async () => {
    const interaction = stubInteraction();
    const fn = vi.fn().mockResolvedValue(undefined);
    await wrapErrors('button', 'test:id', interaction, fn);
    expect(fn).toHaveBeenCalled();
    expect((interaction as any).reply).not.toHaveBeenCalled();
  });

  it('replies ephemeral when the fn throws and interaction is fresh', async () => {
    const interaction = stubInteraction({ replied: false, deferred: false });
    const fn = vi.fn().mockRejectedValue(new Error('boom'));
    await wrapErrors('button', 'test:id', interaction, fn);
    expect((interaction as any).reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringMatching(/error/i) }),
    );
  });

  it('followUps ephemeral when the fn throws and interaction was already replied', async () => {
    const interaction = stubInteraction({ replied: true });
    const fn = vi.fn().mockRejectedValue(new Error('boom'));
    await wrapErrors('button', 'test:id', interaction, fn);
    expect((interaction as any).followUp).toHaveBeenCalled();
    expect((interaction as any).reply).not.toHaveBeenCalled();
  });

  it('followUps ephemeral when the fn throws and interaction was deferred', async () => {
    const interaction = stubInteraction({ deferred: true });
    const fn = vi.fn().mockRejectedValue(new Error('boom'));
    await wrapErrors('button', 'test:id', interaction, fn);
    expect((interaction as any).followUp).toHaveBeenCalled();
  });
});
```

### Step 1.2: Run tests to verify they fail

- [ ] Run: `npm test -- tests/unit/interactions/middleware.test.ts`
- [ ] Expected: FAIL — module `src/interactions/middleware.js` not found.

### Step 1.3: Implement middleware

- [ ] Create `src/interactions/middleware.ts`:

```ts
import { MessageFlags } from 'discord.js';
import type { ButtonInteraction, ModalSubmitInteraction, UserSelectMenuInteraction, GuildMember } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../services/logger.js';

export type InteractionKind = 'button' | 'modal' | 'select';

type Gatable = ButtonInteraction | ModalSubmitInteraction | UserSelectMenuInteraction;

/**
 * Returns true if the member holds the configured officer role. If not, replies
 * ephemeral with a permission-denied message and returns false. The caller
 * should early-return on false without further action.
 */
export async function requireOfficer(interaction: Gatable, kind: InteractionKind): Promise<boolean> {
  const member = interaction.member as GuildMember | null;
  if (member?.roles.cache.has(config.officerRoleId)) return true;

  await interaction.reply({
    content: 'You do not have permission to do this.',
    flags: MessageFlags.Ephemeral,
  }).catch(() => {});
  return false;
}

/**
 * Runs the given fn inside a try/catch. On throw, logs with customId + kind and
 * replies or followUps ephemeral with a generic error message. Never rethrows.
 *
 * This is the LAST-RESORT error net — handler bodies may wrap their own
 * try/catch around specific operations to produce richer messages. This catches
 * anything that escapes those.
 */
export async function wrapErrors(
  kind: InteractionKind,
  customId: string,
  interaction: Gatable,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('interaction', `${kind} handler failed (${customId}): ${err.message}`, err);

    const reply = { content: `An error occurred handling this ${kind}.`, flags: MessageFlags.Ephemeral } as const;
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(reply).catch(() => {});
    } else {
      await interaction.reply(reply).catch(() => {});
    }
  }
}
```

### Step 1.4: Run middleware tests to verify they pass

- [ ] Run: `npm test -- tests/unit/interactions/middleware.test.ts`
- [ ] Expected: PASS — all 6 tests green.

### Step 1.5: Write the failing dispatch tests

- [ ] Create `tests/unit/interactions/dispatch.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ButtonInteraction } from 'discord.js';
import { dispatch, type ButtonHandler } from '../../../src/interactions/registry.js';

vi.mock('../../../src/config.js', () => ({ config: { officerRoleId: 'OFFICER' } }));
vi.mock('../../../src/services/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

function stubInteraction(opts: { hasRole?: boolean } = {}) {
  return {
    member: { roles: { cache: { has: () => opts.hasRole === true } } },
    replied: false,
    deferred: false,
    reply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
  } as unknown as ButtonInteraction;
}

describe('dispatch', () => {
  let handleA: ReturnType<typeof vi.fn>;
  let handleB: ReturnType<typeof vi.fn>;
  let handlers: ButtonHandler[];

  beforeEach(() => {
    handleA = vi.fn().mockResolvedValue(undefined);
    handleB = vi.fn().mockResolvedValue(undefined);
    handlers = [
      { prefix: 'foo:exact', handle: handleA },
      { prefix: 'foo:prefixed', handle: handleB },
    ];
  });

  it('routes an exact-match customId to the right handler with empty params', async () => {
    await dispatch(handlers, 'button', stubInteraction(), 'foo:exact');
    expect(handleA).toHaveBeenCalledWith(expect.anything(), []);
    expect(handleB).not.toHaveBeenCalled();
  });

  it('routes a prefix-with-colon customId and splits the tail into params', async () => {
    await dispatch(handlers, 'button', stubInteraction(), 'foo:prefixed:42:abc');
    expect(handleB).toHaveBeenCalledWith(expect.anything(), ['42', 'abc']);
  });

  it('logs a warning and calls no handler when no prefix matches', async () => {
    const { logger } = await import('../../../src/services/logger.js');
    await dispatch(handlers, 'button', stubInteraction(), 'unknown:id');
    expect(handleA).not.toHaveBeenCalled();
    expect(handleB).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('interaction', expect.stringMatching(/Unhandled button: unknown:id/));
  });

  it('does not route foo:prefixedextra to the foo:prefixed handler (boundary check)', async () => {
    // Prefix match requires exact match OR prefix + ':' — so 'foo:prefixed' must not match 'foo:prefixedextra'
    await dispatch(handlers, 'button', stubInteraction(), 'foo:prefixedextra');
    expect(handleB).not.toHaveBeenCalled();
  });

  it('short-circuits when officerOnly is true and the gate fails', async () => {
    const gated: ButtonHandler[] = [{ prefix: 'gated', officerOnly: true, handle: handleA }];
    const interaction = stubInteraction({ hasRole: false });
    await dispatch(gated, 'button', interaction, 'gated');
    expect(handleA).not.toHaveBeenCalled();
    expect((interaction as any).reply).toHaveBeenCalled();
  });

  it('runs when officerOnly is true and the gate passes', async () => {
    const gated: ButtonHandler[] = [{ prefix: 'gated', officerOnly: true, handle: handleA }];
    const interaction = stubInteraction({ hasRole: true });
    await dispatch(gated, 'button', interaction, 'gated');
    expect(handleA).toHaveBeenCalled();
  });

  it('catches and logs a handler throw via wrapErrors', async () => {
    const throwing: ButtonHandler[] = [{ prefix: 'boom', handle: vi.fn().mockRejectedValue(new Error('kaboom')) }];
    const interaction = stubInteraction();
    await dispatch(throwing, 'button', interaction, 'boom');
    expect((interaction as any).reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringMatching(/error/i) }),
    );
  });
});
```

### Step 1.6: Run tests to verify they fail

- [ ] Run: `npm test -- tests/unit/interactions/dispatch.test.ts`
- [ ] Expected: FAIL — module `src/interactions/registry.js` not found.

### Step 1.7: Implement the registry file with types, dispatch, and empty arrays

- [ ] Create `src/interactions/registry.ts`:

```ts
import type {
  ButtonInteraction,
  ModalSubmitInteraction,
  UserSelectMenuInteraction,
} from 'discord.js';
import { logger } from '../services/logger.js';
import { requireOfficer, wrapErrors, type InteractionKind } from './middleware.js';

export type ButtonHandler = {
  prefix: string;
  officerOnly?: boolean;
  handle(interaction: ButtonInteraction, params: string[]): Promise<void>;
};

export type ModalHandler = {
  prefix: string;
  officerOnly?: boolean;
  handle(interaction: ModalSubmitInteraction, params: string[]): Promise<void>;
};

export type UserSelectHandler = {
  prefix: string;
  officerOnly?: boolean;
  handle(interaction: UserSelectMenuInteraction, params: string[]): Promise<void>;
};

type AnyHandler = ButtonHandler | ModalHandler | UserSelectHandler;
type AnyInteraction = ButtonInteraction | ModalSubmitInteraction | UserSelectMenuInteraction;

/**
 * Finds the first handler whose prefix matches the customId (exact match OR
 * prefix followed by ':'), runs officer-gate middleware if declared, extracts
 * params (':'-separated tail), and invokes the handler inside wrapErrors.
 *
 * Returns without calling any handler (and logs a warning) if no prefix matches.
 */
export async function dispatch<H extends AnyHandler, I extends AnyInteraction>(
  handlers: H[],
  kind: InteractionKind,
  interaction: I,
  customId: string,
): Promise<void> {
  const handler = handlers.find(
    h => customId === h.prefix || customId.startsWith(h.prefix + ':'),
  );

  if (!handler) {
    logger.warn('interaction', `Unhandled ${kind}: ${customId}`);
    return;
  }

  if (handler.officerOnly && !(await requireOfficer(interaction, kind))) return;

  const tail = customId === handler.prefix ? '' : customId.slice(handler.prefix.length + 1);
  const params = tail ? tail.split(':') : [];

  await wrapErrors(kind, customId, interaction, () =>
    (handler.handle as (i: I, p: string[]) => Promise<void>)(interaction, params),
  );
}

// Populated in task 3 onwards. Empty for now.
export const buttonHandlers: ButtonHandler[] = [];
export const modalHandlers: ModalHandler[] = [];
export const userSelectHandlers: UserSelectHandler[] = [];
```

### Step 1.8: Run dispatch tests to verify they pass

- [ ] Run: `npm test -- tests/unit/interactions/dispatch.test.ts`
- [ ] Expected: PASS — all 7 tests green.

### Step 1.9: Run full test suite to verify no regression

- [ ] Run: `npm test`
- [ ] Expected: PASS — full suite green. Existing tests unaffected since `interactionCreate.ts` not yet modified.

### Step 1.10: Commit

- [ ] Run:

```bash
git add src/interactions/registry.ts src/interactions/middleware.ts tests/unit/interactions/
git commit -m "feat(interactions): add registry + middleware infrastructure

New src/interactions/ directory with handler types, dispatch() helper,
requireOfficer / wrapErrors middleware, and empty registry arrays.
No integration yet — interactionCreate.ts is unchanged."
```

---

## Task 2: Hook new dispatcher into interactionCreate.ts (dual-dispatch, empty registry)

Add the new dispatcher in front of the existing if-cascade. With empty registries, the dispatcher is a no-op (logs `Unhandled` for every interaction — actually no, since all handlers still exist in the cascade, the dispatcher must NOT log warn when it doesn't match during migration. We change the dispatcher's behavior here). See step 2.1 for the concrete change.

**Files:**
- Modify: `src/events/interactionCreate.ts`
- Modify: `src/interactions/registry.ts`
- Modify: `tests/unit/interactions/dispatch.test.ts`

### Step 2.1: Update dispatch to return whether it handled

During migration, the dispatcher runs first and the old cascade runs as a fallback. We need `dispatch()` to signal whether it found a handler so the caller knows whether to skip the cascade. Change the return type to `Promise<boolean>`.

- [ ] Edit `src/interactions/registry.ts` — change the `dispatch` function signature and body:

```ts
export async function dispatch<H extends AnyHandler, I extends AnyInteraction>(
  handlers: H[],
  kind: InteractionKind,
  interaction: I,
  customId: string,
): Promise<boolean> {
  const handler = handlers.find(
    h => customId === h.prefix || customId.startsWith(h.prefix + ':'),
  );

  if (!handler) return false;

  if (handler.officerOnly && !(await requireOfficer(interaction, kind))) return true;

  const tail = customId === handler.prefix ? '' : customId.slice(handler.prefix.length + 1);
  const params = tail ? tail.split(':') : [];

  await wrapErrors(kind, customId, interaction, () =>
    (handler.handle as (i: I, p: string[]) => Promise<void>)(interaction, params),
  );
  return true;
}
```

Note: `logger.warn('interaction', 'Unhandled ...')` removed — that logging now happens in `interactionCreate.ts` ONLY when both the registry and the legacy cascade miss. This gets re-added to the dispatcher in task 8 once the cascade is gone.

### Step 2.2: Update dispatch tests for the new return type

- [ ] Edit `tests/unit/interactions/dispatch.test.ts`:

Change the "no prefix matches" test body:

```ts
  it('returns false and calls no handler when no prefix matches', async () => {
    const result = await dispatch(handlers, 'button', stubInteraction(), 'unknown:id');
    expect(result).toBe(false);
    expect(handleA).not.toHaveBeenCalled();
    expect(handleB).not.toHaveBeenCalled();
  });
```

Remove the logger import in that test (no longer needed since the warn now lives in the caller).

Add a test asserting dispatch returns true on a match:

```ts
  it('returns true when a handler runs', async () => {
    const result = await dispatch(handlers, 'button', stubInteraction(), 'foo:exact');
    expect(result).toBe(true);
  });
```

### Step 2.3: Run dispatch tests to verify they still pass

- [ ] Run: `npm test -- tests/unit/interactions/dispatch.test.ts`
- [ ] Expected: PASS — 7 tests green (one renamed/rewritten, one added, short-circuit still works).

### Step 2.4: Modify interactionCreate.ts to run dispatch before the cascade

- [ ] Edit `src/events/interactionCreate.ts`:

Add imports near the top (after the existing imports):

```ts
import {
  buttonHandlers,
  modalHandlers,
  userSelectHandlers,
  dispatch,
} from '../interactions/registry.js';
```

Inside `execute`, add a call to `dispatch` at the start of each `if (interaction.isButton())`, `if (interaction.isUserSelectMenu())`, and `if (interaction.isModalSubmit())` block, BEFORE the existing try/catch. If dispatch returns true, return early.

Concretely, find the line `if (interaction.isButton()) {` (currently around line 70). Immediately inside the block, add:

```ts
    if (interaction.isButton()) {
      const customId = interaction.customId;

      if (await dispatch(buttonHandlers, 'button', interaction, customId)) return;

      try {
        // ...existing cascade unchanged...
```

Note: there's already a `const customId = interaction.customId;` line in the current code — don't duplicate it. Hoist the dispatch call so it uses the same declaration. The `const customId` line moves up one block if needed.

Do the same for the user select block (currently around line 502):

```ts
    if (interaction.isUserSelectMenu()) {
      const customId = interaction.customId;

      if (await dispatch(userSelectHandlers, 'select', interaction, customId)) return;

      try {
        // ...existing cascade unchanged...
```

And the modal block (currently around line 551):

```ts
    if (interaction.isModalSubmit()) {
      const customId = interaction.customId;

      if (await dispatch(modalHandlers, 'modal', interaction, customId)) return;

      try {
        // ...existing cascade unchanged...
```

### Step 2.5: Run full test suite

- [ ] Run: `npm test`
- [ ] Expected: PASS — existing tests green. All interactions still route through the cascade (registries are empty, so dispatch always returns false).

### Step 2.6: Run type checker

- [ ] Run: `npm run build` (or whatever the typecheck command is — `npx tsc --noEmit` if build runs more)
- [ ] Expected: no type errors.

### Step 2.7: Commit

- [ ] Run:

```bash
git add src/events/interactionCreate.ts src/interactions/registry.ts tests/unit/interactions/dispatch.test.ts
git commit -m "feat(interactions): wire dispatcher into interactionCreate

Dual-dispatch scaffold: the new dispatcher runs first for each interaction
kind; if no handler is registered, the existing if-cascade runs unchanged.
Registries are empty, so every interaction still routes through the
cascade — zero behavior change."
```

---

## Task 3: Migrate pagination

Simplest domain — one handler, no officer gate, no modal. Move first to validate the migration pattern.

**Files:**
- Create: `src/interactions/pagination.ts`
- Modify: `src/interactions/registry.ts`
- Modify: `src/events/interactionCreate.ts`

### Step 3.1: Create pagination domain module

- [ ] Create `src/interactions/pagination.ts`:

```ts
import { MessageFlags } from 'discord.js';
import type { ButtonInteraction } from 'discord.js';
import type { ButtonHandler } from './registry.js';
import { getCachedPage, buildPageEmbed, buildPageButtons } from '../functions/pagination.js';

async function handlePage(interaction: ButtonInteraction, params: string[]): Promise<void> {
  // customId format: page:{commandName}:{targetPage}:{totalPages}
  // params = [commandName, targetPage, totalPages]
  const commandName = params[0];
  const page = parseInt(params[1], 10);

  const cacheKey = `${commandName}:${interaction.message.id}`;
  const data = getCachedPage(cacheKey, page);

  if (!data) {
    await interaction.reply({
      content: 'This list has expired. Please run the command again.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const embed = buildPageEmbed(data.title, data.content, page, data.totalPages);
  const buttons = buildPageButtons(commandName, page, data.totalPages);
  await interaction.update({
    embeds: [embed],
    components: buttons ? [buttons] : [],
  });
}

export const buttons: ButtonHandler[] = [
  { prefix: 'page', handle: handlePage },
];
```

### Step 3.2: Register pagination in the registry

- [ ] Edit `src/interactions/registry.ts` — replace the `buttonHandlers`, `modalHandlers`, `userSelectHandlers` lines at the bottom:

```ts
import * as pagination from './pagination.js';

export const buttonHandlers: ButtonHandler[] = [
  ...pagination.buttons,
];
export const modalHandlers: ModalHandler[] = [];
export const userSelectHandlers: UserSelectHandler[] = [];
```

### Step 3.3: Remove the pagination branch from interactionCreate.ts

- [ ] Edit `src/events/interactionCreate.ts`:

Locate the pagination block inside the button cascade (currently lines 396–419):

```ts
        // page:{commandName}:{targetPage}:{totalPages} - Pagination navigation
        if (customId.startsWith('page:')) {
          const parts = customId.split(':');
          const commandName = parts[1];
          const page = parseInt(parts[2], 10);

          const cacheKey = `${commandName}:${interaction.message.id}`;
          const data = getCachedPage(cacheKey, page);

          if (!data) {
            await interaction.reply({
              content: 'This list has expired. Please run the command again.',
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          const embed = buildPageEmbed(data.title, data.content, page, data.totalPages);
          const buttons = buildPageButtons(commandName, page, data.totalPages);
          await interaction.update({
            embeds: [embed],
            components: buttons ? [buttons] : [],
          });
        }
```

Delete those lines in their entirety.

Also remove the now-unused imports at the top:

```ts
import { getCachedPage, buildPageEmbed, buildPageButtons } from '../functions/pagination.js';
```

### Step 3.4: Run full test suite

- [ ] Run: `npm test`
- [ ] Expected: PASS — pagination tests unchanged (they test `functions/pagination.ts`, not the handler).

### Step 3.5: Run typecheck

- [ ] Run: `npx tsc --noEmit`
- [ ] Expected: no errors.

### Step 3.6: Commit

- [ ] Run:

```bash
git add src/interactions/pagination.ts src/interactions/registry.ts src/events/interactionCreate.ts
git commit -m "refactor(interactions): migrate pagination to registry

Extracts the page:{...} button handler from interactionCreate.ts into
src/interactions/pagination.ts. Behavior and customId unchanged."
```

---

## Task 4: Migrate loot

One handler, no officer gate, uses non-officer gate ("user has linked raider"). Includes inline raider-grouping logic — keep that inline in the handler body, do NOT extract (per spec's deferred list).

**Files:**
- Create: `src/interactions/loot.ts`
- Modify: `src/interactions/registry.ts`
- Modify: `src/events/interactionCreate.ts`

### Step 4.1: Create loot domain module

- [ ] Create `src/interactions/loot.ts`:

```ts
import { MessageFlags } from 'discord.js';
import type { ButtonInteraction } from 'discord.js';
import type { ButtonHandler } from './registry.js';
import { getDatabase } from '../database/db.js';
import { updateLootResponse } from '../functions/loot/updateLootResponse.js';
import { generateLootPost } from '../functions/loot/generateLootPost.js';
import type { LootPostRow, LootResponseRow, RaiderRow } from '../types/index.js';

async function handleLoot(interaction: ButtonInteraction, params: string[]): Promise<void> {
  // customId format: loot:{responseType}:{bossId}
  // params = [responseType, bossIdStr]
  const responseType = params[0];
  const bossId = parseInt(params[1], 10);

  const db = getDatabase();
  const raider = db
    .prepare('SELECT * FROM raiders WHERE discord_user_id = ?')
    .get(interaction.user.id) as RaiderRow | undefined;

  if (!raider) {
    await interaction.reply({
      content: 'Could not find a character linked to your Discord account. Please contact an officer!',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await updateLootResponse(interaction.client, responseType, bossId, interaction.user.id);

  const lootPost = db
    .prepare('SELECT * FROM loot_posts WHERE boss_id = ?')
    .get(bossId) as LootPostRow | undefined;

  if (lootPost) {
    const responses = db
      .prepare('SELECT * FROM loot_responses WHERE loot_post_id = ?')
      .all(lootPost.id) as LootResponseRow[];

    const raiders = db
      .prepare('SELECT * FROM raiders WHERE discord_user_id IS NOT NULL')
      .all() as RaiderRow[];

    const userToCharacter = new Map<string, string>();
    for (const r of raiders) {
      if (r.discord_user_id && !userToCharacter.has(r.discord_user_id)) {
        userToCharacter.set(r.discord_user_id, r.character_name);
      }
    }

    const grouped: Record<string, string[]> = {
      major: [],
      minor: [],
      wantIn: [],
      wantOut: [],
    };

    for (const response of responses) {
      const charName = userToCharacter.get(response.user_id) ?? 'Unknown';
      if (grouped[response.response_type]) {
        grouped[response.response_type].push(charName);
      }
    }

    const playerResponses = {
      major: grouped.major.length > 0 ? grouped.major.join('\n') : '*None*',
      minor: grouped.minor.length > 0 ? grouped.minor.join('\n') : '*None*',
      wantIn: grouped.wantIn.length > 0 ? grouped.wantIn.join('\n') : '*None*',
      wantOut: grouped.wantOut.length > 0 ? grouped.wantOut.join('\n') : '*None*',
    };

    const postData = generateLootPost(lootPost.boss_name, bossId, playerResponses);
    await interaction.update(postData);
  }
}

export const buttons: ButtonHandler[] = [
  { prefix: 'loot', handle: handleLoot },
];
```

### Step 4.2: Register loot in the registry

- [ ] Edit `src/interactions/registry.ts`:

```ts
import * as pagination from './pagination.js';
import * as loot from './loot.js';

export const buttonHandlers: ButtonHandler[] = [
  ...pagination.buttons,
  ...loot.buttons,
];
```

### Step 4.3: Remove the loot branch from interactionCreate.ts

- [ ] Edit `src/events/interactionCreate.ts`:

Delete the loot block inside the button cascade (currently lines 421–487, starting with `// loot:{responseType}:{bossId}` comment and ending with `await interaction.update(postData); } }`). Also remove now-unused imports at the top:

```ts
import { updateLootResponse } from '../functions/loot/updateLootResponse.js';
import { updateLootPost } from '../functions/loot/updateLootPost.js';
import { generateLootPost } from '../functions/loot/generateLootPost.js';
import type { LootPostRow, LootResponseRow } from '../types/index.js';
```

Note: keep `RaiderRow` import — still used by other handlers in the cascade until later tasks.

### Step 4.4: Run tests and typecheck

- [ ] Run: `npm test && npx tsc --noEmit`
- [ ] Expected: PASS, no type errors.

### Step 4.5: Commit

- [ ] Run:

```bash
git add src/interactions/loot.ts src/interactions/registry.ts src/events/interactionCreate.ts
git commit -m "refactor(interactions): migrate loot to registry"
```

---

## Task 5: Migrate raider (3 buttons + 1 user select)

Buttons: `raider:confirm_link`, `raider:reject_link`, `raider:ignore`. User select: `raider:select_user`. None use the officer gate in the current code (they should, but that's a pre-existing bug and out of scope — preserve current behavior).

**Files:**
- Create: `src/interactions/raider.ts`
- Modify: `src/interactions/registry.ts`
- Modify: `src/events/interactionCreate.ts`

### Step 5.1: Create raider domain module

- [ ] Create `src/interactions/raider.ts`:

```ts
import { MessageFlags } from 'discord.js';
import type { ButtonInteraction, UserSelectMenuInteraction } from 'discord.js';
import type { ButtonHandler, UserSelectHandler } from './registry.js';
import { getDatabase } from '../database/db.js';
import { audit } from '../services/auditLog.js';
import { updateRaiderDiscordUser } from '../functions/raids/updateRaiderDiscordUser.js';
import { ignoreCharacter } from '../functions/raids/ignoreCharacter.js';
import { sendAlertForRaidersWithNoUser } from '../functions/raids/sendAlertForRaidersWithNoUser.js';
import type { RaiderRow } from '../types/index.js';

async function confirmLink(interaction: ButtonInteraction, params: string[]): Promise<void> {
  // customId: raider:confirm_link:{characterName}:{userId}
  const characterName = params[0];
  const userId = params[1];

  const success = await updateRaiderDiscordUser(interaction.client, characterName, userId);

  if (success) {
    await audit(interaction.user, 'confirmed raider link', `${characterName} -> <@${userId}>`);
    await interaction.update({
      content: `Linked **${characterName}** to <@${userId}>!`,
      components: [],
    });
  } else {
    await interaction.reply({
      content: `Failed to link **${characterName}**.`,
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function rejectLink(interaction: ButtonInteraction, params: string[]): Promise<void> {
  // customId: raider:reject_link:{characterName}
  const characterName = params[0];

  try {
    await interaction.message.delete();
  } catch {
    // Message may already be deleted
  }

  const db = getDatabase();
  const raider = db
    .prepare('SELECT * FROM raiders WHERE character_name = ?')
    .get(characterName) as RaiderRow | undefined;

  if (raider) {
    db.prepare('UPDATE raiders SET message_id = NULL WHERE character_name = ?').run(characterName);
    await sendAlertForRaidersWithNoUser(interaction.client, [raider], []);
  }
}

async function ignore(interaction: ButtonInteraction, params: string[]): Promise<void> {
  // customId: raider:ignore:{characterName}
  const characterName = params[0];
  const success = ignoreCharacter(characterName);

  if (success) {
    await audit(interaction.user, 'ignored character via button', characterName);

    try {
      await interaction.message.delete();
    } catch {
      // Message may already be deleted
    }

    await interaction.reply({
      content: `Ignored **${characterName}** and removed from raiders.`,
      flags: MessageFlags.Ephemeral,
    });
  } else {
    await interaction.reply({
      content: `Failed to ignore **${characterName}**.`,
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function selectUser(interaction: UserSelectMenuInteraction, params: string[]): Promise<void> {
  // customId: raider:select_user:{characterName}
  const characterName = params[0];
  const selectedUserId = interaction.values[0];

  const success = await updateRaiderDiscordUser(interaction.client, characterName, selectedUserId);

  if (success) {
    await audit(interaction.user, 'linked raider via select', `${characterName} -> <@${selectedUserId}>`);

    try {
      await interaction.message.delete();
    } catch {
      // Message may already be deleted
    }

    await interaction.reply({
      content: `Linked **${characterName}** to <@${selectedUserId}>.`,
      flags: MessageFlags.Ephemeral,
    });
  } else {
    await interaction.reply({
      content: `Failed to link **${characterName}**.`,
      flags: MessageFlags.Ephemeral,
    });
  }
}

export const buttons: ButtonHandler[] = [
  { prefix: 'raider:confirm_link', handle: confirmLink },
  { prefix: 'raider:reject_link', handle: rejectLink },
  { prefix: 'raider:ignore', handle: ignore },
];

export const userSelects: UserSelectHandler[] = [
  { prefix: 'raider:select_user', handle: selectUser },
];
```

### Step 5.2: Register raider in the registry

- [ ] Edit `src/interactions/registry.ts`:

```ts
import * as pagination from './pagination.js';
import * as loot from './loot.js';
import * as raider from './raider.js';

export const buttonHandlers: ButtonHandler[] = [
  ...pagination.buttons,
  ...loot.buttons,
  ...raider.buttons,
];
export const modalHandlers: ModalHandler[] = [];
export const userSelectHandlers: UserSelectHandler[] = [
  ...raider.userSelects,
];
```

### Step 5.3: Remove raider branches from interactionCreate.ts

- [ ] Edit `src/events/interactionCreate.ts`:

Delete these blocks from the button cascade:
- `// raider:confirm_link:{characterName}:{userId}` block (lines ~74–98)
- `// raider:reject_link:{characterName}` block (lines ~100–121)
- `// raider:ignore:{characterName}` block (lines ~123–147)

Delete the entire `if (interaction.isUserSelectMenu()) { ... }` block (lines ~502–548) — after deletion, the only user-select handler was `raider:select_user`, so the whole block is now redundant. HOWEVER, the dispatch at the top of that block must remain — the dispatcher runs first and routes to `raider.userSelects`. Re-examine the block structure:

Before (after task 2):

```ts
    if (interaction.isUserSelectMenu()) {
      const customId = interaction.customId;

      if (await dispatch(userSelectHandlers, 'select', interaction, customId)) return;

      try {
        // raider:select_user:{characterName}
        if (customId.startsWith('raider:select_user:')) { /* ... */ }
      } catch (error) { /* ... */ }
    }
```

After task 5:

```ts
    if (interaction.isUserSelectMenu()) {
      const customId = interaction.customId;
      if (await dispatch(userSelectHandlers, 'select', interaction, customId)) return;
      logger.warn('interaction', `Unhandled select: ${customId}`);
    }
```

Since the registry now covers every user-select handler, the try/catch block below is dead code. Keep the block itself for symmetry with the button/modal blocks during migration, but remove the inner try/catch body (replace with the warn line).

Also remove now-unused imports at the top:
- `updateRaiderDiscordUser`
- `ignoreCharacter`
- `sendAlertForRaidersWithNoUser`
- `RaiderRow` (NOW safe to remove since loot moved in task 4)

### Step 5.4: Run tests and typecheck

- [ ] Run: `npm test && npx tsc --noEmit`
- [ ] Expected: PASS, no type errors.

### Step 5.5: Commit

- [ ] Run:

```bash
git add src/interactions/raider.ts src/interactions/registry.ts src/events/interactionCreate.ts
git commit -m "refactor(interactions): migrate raider buttons + user select to registry"
```

---

## Task 6: Migrate trial (4 buttons + 2 modals)

Trial buttons all need the officer gate (`trial:update_info`, `trial:extend`, `trial:mark_promote`, `trial:close`). Set `officerOnly: true` on each — this replaces 4 duplicate inline role checks. The `trial:update_info` handler builds a ModalBuilder inline — keep that inline per spec's deferred list. Modals: `trial:modal:create`, `trial:modal:update`.

**Files:**
- Create: `src/interactions/trial.ts`
- Modify: `src/interactions/registry.ts`
- Modify: `src/events/interactionCreate.ts`

### Step 6.1: Create trial domain module

- [ ] Create `src/interactions/trial.ts`:

```ts
import {
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} from 'discord.js';
import type { ButtonInteraction, ModalSubmitInteraction } from 'discord.js';
import type { ButtonHandler, ModalHandler } from './registry.js';
import { getDatabase } from '../database/db.js';
import { audit } from '../services/auditLog.js';
import { logger } from '../services/logger.js';
import { extendTrial } from '../functions/trial-review/extendTrial.js';
import { markForPromotion } from '../functions/trial-review/markForPromotion.js';
import { closeTrial } from '../functions/trial-review/closeTrial.js';
import { changeTrialInfo } from '../functions/trial-review/changeTrialInfo.js';
import { createTrialReviewThread } from '../functions/trial-review/createTrialReviewThread.js';
import type { TrialRow } from '../types/index.js';

async function updateInfo(interaction: ButtonInteraction, params: string[]): Promise<void> {
  const trialId = parseInt(params[0], 10);
  const db = getDatabase();
  const trial = db.prepare('SELECT * FROM trials WHERE id = ?').get(trialId) as TrialRow | undefined;

  if (!trial) {
    await interaction.reply({ content: 'Trial not found.', flags: MessageFlags.Ephemeral });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`trial:modal:update:${trialId}`)
    .setTitle('Update Trial Info');

  const charNameInput = new TextInputBuilder()
    .setCustomId('character_name').setLabel('Character Name')
    .setStyle(TextInputStyle.Short).setValue(trial.character_name).setRequired(true);

  const roleInput = new TextInputBuilder()
    .setCustomId('role').setLabel('Role')
    .setStyle(TextInputStyle.Short).setValue(trial.role).setRequired(true);

  const startDateInput = new TextInputBuilder()
    .setCustomId('start_date').setLabel('Start Date (YYYY-MM-DD)')
    .setStyle(TextInputStyle.Short).setValue(trial.start_date).setRequired(true);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(charNameInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(roleInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(startDateInput),
  );

  await interaction.showModal(modal);
}

async function extend(interaction: ButtonInteraction, params: string[]): Promise<void> {
  const trialId = parseInt(params[0], 10);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    await extendTrial(interaction.client, trialId);
    await audit(interaction.user, 'extended trial', `#${trialId}`);
    await interaction.editReply({ content: 'Trial extended by 1 week.' });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    await interaction.editReply({ content: `Failed to extend trial: ${error.message}` });
  }
}

async function markPromote(interaction: ButtonInteraction, params: string[]): Promise<void> {
  const trialId = parseInt(params[0], 10);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    await markForPromotion(interaction.client, trialId);
    await audit(interaction.user, 'marked trial for promotion', `#${trialId}`);
    await interaction.editReply({ content: 'Trial marked for promotion.' });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    await interaction.editReply({ content: `Failed: ${error.message}` });
  }
}

async function close(interaction: ButtonInteraction, params: string[]): Promise<void> {
  const trialId = parseInt(params[0], 10);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    await closeTrial(interaction.client, trialId);
    await audit(interaction.user, 'closed trial', `#${trialId}`);
    await interaction.editReply({ content: 'Trial closed.' });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    await interaction.editReply({ content: `Failed to close trial: ${error.message}` });
  }
}

async function modalCreate(interaction: ModalSubmitInteraction, _params: string[]): Promise<void> {
  const characterName = interaction.fields.getTextInputValue('character_name');
  const role = interaction.fields.getTextInputValue('role');
  const startDate = interaction.fields.getTextInputValue('start_date');

  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    await interaction.reply({
      content: 'Invalid date format. Please use YYYY-MM-DD.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const trial = await createTrialReviewThread(interaction.client, { characterName, role, startDate });
    await audit(interaction.user, 'created trial', `${characterName} as ${role} (#${trial.id})`);
    await interaction.editReply({
      content: `Trial created for **${characterName}**. Thread: <#${trial.thread_id}>`,
    });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error('Trials', `Failed to create trial: ${error.message}`, error);
    await interaction.editReply({ content: `Failed to create trial: ${error.message}` });
  }
}

async function modalUpdate(interaction: ModalSubmitInteraction, params: string[]): Promise<void> {
  const trialId = parseInt(params[0], 10);
  const characterName = interaction.fields.getTextInputValue('character_name');
  const role = interaction.fields.getTextInputValue('role');
  const startDate = interaction.fields.getTextInputValue('start_date');

  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    await interaction.reply({
      content: 'Invalid date format. Please use YYYY-MM-DD.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const db = getDatabase();
    const trial = db.prepare('SELECT * FROM trials WHERE id = ?').get(trialId) as TrialRow | undefined;

    if (!trial) {
      await interaction.editReply({ content: 'Trial not found.' });
      return;
    }

    const updates: Record<string, string | undefined> = {};
    if (characterName !== trial.character_name) updates.characterName = characterName;
    if (role !== trial.role) updates.role = role;
    if (startDate !== trial.start_date) updates.startDate = startDate;

    if (Object.keys(updates).length === 0) {
      await interaction.editReply({ content: 'No changes detected.' });
      return;
    }

    await changeTrialInfo(interaction.client, trialId, updates);
    await audit(interaction.user, 'updated trial info via modal', `${trial.character_name} (#${trialId})`);
    await interaction.editReply({ content: 'Trial info updated.' });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    await interaction.editReply({ content: `Failed to update trial: ${error.message}` });
  }
}

export const buttons: ButtonHandler[] = [
  { prefix: 'trial:update_info', officerOnly: true, handle: updateInfo },
  { prefix: 'trial:extend', officerOnly: true, handle: extend },
  { prefix: 'trial:mark_promote', officerOnly: true, handle: markPromote },
  { prefix: 'trial:close', officerOnly: true, handle: close },
];

export const modals: ModalHandler[] = [
  { prefix: 'trial:modal:create', handle: modalCreate },
  { prefix: 'trial:modal:update', handle: modalUpdate },
];
```

### Step 6.2: Register trial in the registry

- [ ] Edit `src/interactions/registry.ts`:

```ts
import * as pagination from './pagination.js';
import * as loot from './loot.js';
import * as raider from './raider.js';
import * as trial from './trial.js';

export const buttonHandlers: ButtonHandler[] = [
  ...pagination.buttons,
  ...loot.buttons,
  ...raider.buttons,
  ...trial.buttons,
];
export const modalHandlers: ModalHandler[] = [
  ...trial.modals,
];
export const userSelectHandlers: UserSelectHandler[] = [
  ...raider.userSelects,
];
```

### Step 6.3: Remove trial branches from interactionCreate.ts

- [ ] Edit `src/events/interactionCreate.ts`:

Delete from the button cascade:
- `// trial:update_info:{trialId}` block (lines ~266–322)
- `// trial:extend:{trialId}` block (lines ~324–346)
- `// trial:mark_promote:{trialId}` block (lines ~348–370)
- `// trial:close:{trialId}` block (lines ~372–394)

Delete from the modal cascade:
- `// trial:modal:create` block (lines ~594–624)
- `// trial:modal:update:{trialId}` block (lines ~626–677)

Remove now-unused imports at the top:
- `ModalBuilder`, `TextInputBuilder`, `TextInputStyle`, `ActionRowBuilder` from `discord.js` (check — `GuildMember` is also only used for the trial officer checks; remove it too)
- `config` (only used for `config.officerRoleId` in trial checks — confirm no other use in this file before removing)
- `extendTrial`, `markForPromotion`, `closeTrial`, `changeTrialInfo`, `createTrialReviewThread`
- `TrialRow` type

### Step 6.4: Run tests and typecheck

- [ ] Run: `npm test && npx tsc --noEmit`
- [ ] Expected: PASS, no type errors.

### Step 6.5: Commit

- [ ] Run:

```bash
git add src/interactions/trial.ts src/interactions/registry.ts src/events/interactionCreate.ts
git commit -m "refactor(interactions): migrate trial buttons + modals to registry

Four duplicate officer-role-check blocks collapse to officerOnly:true on
each trial button handler entry."
```

---

## Task 7: Migrate application (7 buttons + 4 modals)

Largest domain. No officer gates on the buttons (application voting and acceptance buttons are gated by visibility — the officer-only review channel — not role checks). The submit button has a handler-specific error path that alerts officers with the app ID; preserve that inline, wrapped in its own try/catch.

**Files:**
- Create: `src/interactions/application.ts`
- Modify: `src/interactions/registry.ts`
- Modify: `src/events/interactionCreate.ts`

### Step 7.1: Create application domain module

- [ ] Create `src/interactions/application.ts`:

```ts
import { MessageFlags } from 'discord.js';
import type { ButtonInteraction, ModalSubmitInteraction } from 'discord.js';
import type { ButtonHandler, ModalHandler } from './registry.js';
import { getDatabase } from '../database/db.js';
import { audit, alertOfficers } from '../services/auditLog.js';
import { logger } from '../services/logger.js';
import { startApplication } from '../functions/applications/startApplication.js';
import { submitApplication } from '../functions/applications/submitApplication.js';
import {
  activeSessions,
  enterEditMode,
  startSessionTimeout,
} from '../functions/applications/dmQuestionnaire.js';
import { voteOnApplication } from '../functions/applications/voteOnApplication.js';
import {
  acceptApplication,
  processAcceptModal,
} from '../functions/applications/acceptApplication.js';
import {
  rejectApplication,
  processRejectModal,
} from '../functions/applications/rejectApplication.js';

async function apply(interaction: ButtonInteraction, _params: string[]): Promise<void> {
  const success = await startApplication(interaction.user);

  if (success) {
    await interaction.reply({
      content: 'Check your DMs! I\'ve sent you the application questions.',
      flags: MessageFlags.Ephemeral,
    });
  } else {
    await interaction.reply({
      content: 'I was unable to send you a DM. Please make sure your DMs are open and try again.',
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function edit(interaction: ButtonInteraction, params: string[]): Promise<void> {
  const applicationId = parseInt(params[0], 10);

  enterEditMode(interaction.user.id, applicationId);
  startSessionTimeout(interaction.user);

  try {
    await interaction.user.send('Which answer would you like to change? (enter the number)');
    await interaction.reply({
      content: 'Check your DMs to edit your answer.',
      flags: MessageFlags.Ephemeral,
    });
  } catch {
    activeSessions.delete(interaction.user.id);
    await interaction.reply({
      content: 'I was unable to send you a DM. Please make sure your DMs are open.',
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function confirm(interaction: ButtonInteraction, params: string[]): Promise<void> {
  const applicationId = parseInt(params[0], 10);

  await interaction.reply({
    content: 'Submitting your application...',
    flags: MessageFlags.Ephemeral,
  });

  try {
    await submitApplication(interaction.client, applicationId, interaction.user);
    await interaction.editReply({
      content: 'Your application has been submitted! Officers will review it shortly.',
    });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error('Applications', `Failed to submit application #${applicationId}: ${error.message}`, error);

    // Officers would otherwise only see this in stdout. Ping the audit
    // channel so they have an action item. Don't await-block the user
    // reply on the alert path — applicant feedback comes first, and
    // alertOfficers catches its own failures. (#42)
    void alertOfficers(
      `Application #${applicationId} submission failed`,
      `Applicant: ${interaction.user.tag} (${interaction.user.id})\nError: ${error.message}`,
    );

    await interaction.editReply({
      content:
        `There was an error submitting your application (saved as #${applicationId}). ` +
        `An officer has been notified — please include application #${applicationId} ` +
        `when following up.`,
    });
  }
}

async function cancel(interaction: ButtonInteraction, params: string[]): Promise<void> {
  const applicationId = parseInt(params[0], 10);
  const db = getDatabase();

  db.prepare('UPDATE applications SET status = ? WHERE id = ?').run('abandoned', applicationId);

  activeSessions.delete(interaction.user.id);

  try {
    await interaction.user.send('Your application has been cancelled. You can apply again anytime with /apply.');
  } catch {
    // DMs may be disabled
  }

  await interaction.reply({
    content: 'Application cancelled.',
    flags: MessageFlags.Ephemeral,
  });
}

async function vote(interaction: ButtonInteraction, params: string[]): Promise<void> {
  // customId: application_vote:{type}:{applicationId}
  // params = [voteType, applicationIdStr]
  const voteType = params[0];
  const applicationId = parseInt(params[1], 10);
  await voteOnApplication(interaction, applicationId, voteType);
}

async function accept(interaction: ButtonInteraction, _params: string[]): Promise<void> {
  await acceptApplication(interaction);
}

async function reject(interaction: ButtonInteraction, _params: string[]): Promise<void> {
  await rejectApplication(interaction);
}

async function modalAcceptMessage(interaction: ModalSubmitInteraction, _params: string[]): Promise<void> {
  const message = interaction.fields.getTextInputValue('message');
  const db = getDatabase();
  db.prepare('INSERT OR REPLACE INTO default_messages (key, message) VALUES (?, ?)')
    .run('application_accept', message);

  await audit(interaction.user, 'updated accept message', message.substring(0, 100));
  await interaction.reply({ content: 'Accept message updated.', flags: MessageFlags.Ephemeral });
}

async function modalRejectMessage(interaction: ModalSubmitInteraction, _params: string[]): Promise<void> {
  const message = interaction.fields.getTextInputValue('message');
  const db = getDatabase();
  db.prepare('INSERT OR REPLACE INTO default_messages (key, message) VALUES (?, ?)')
    .run('application_reject', message);

  await audit(interaction.user, 'updated reject message', message.substring(0, 100));
  await interaction.reply({ content: 'Reject message updated.', flags: MessageFlags.Ephemeral });
}

async function modalAccept(interaction: ModalSubmitInteraction, _params: string[]): Promise<void> {
  await processAcceptModal(interaction);
}

async function modalReject(interaction: ModalSubmitInteraction, _params: string[]): Promise<void> {
  await processRejectModal(interaction);
}

export const buttons: ButtonHandler[] = [
  { prefix: 'application:apply', handle: apply },
  { prefix: 'application:edit', handle: edit },
  { prefix: 'application:confirm', handle: confirm },
  { prefix: 'application:cancel', handle: cancel },
  { prefix: 'application:accept', handle: accept },
  { prefix: 'application:reject', handle: reject },
  { prefix: 'application_vote', handle: vote },  // Note: underscore, not colon (persisted customId in live voting embeds)
];

export const modals: ModalHandler[] = [
  // EXACT-match prefixes must come before prefix-with-colon prefixes for the
  // same root, so 'application:modal:accept_message' doesn't get matched by
  // 'application:modal:accept'. The registry's find() returns first match —
  // list the longer/exact prefixes first.
  { prefix: 'application:modal:accept_message', handle: modalAcceptMessage },
  { prefix: 'application:modal:reject_message', handle: modalRejectMessage },
  { prefix: 'application:modal:accept', handle: modalAccept },
  { prefix: 'application:modal:reject', handle: modalReject },
];
```

**Ordering note for modals:** Listing `application:modal:accept_message` before `application:modal:accept` is defensive, not required. By the boundary rule, customId `application:modal:accept_message` does NOT match prefix `application:modal:accept` (because `startsWith('application:modal:accept:')` is false — the next char is `_`, not `:`). The prefix-collision test in task 9 verifies this holds across the whole registry.

### Step 7.2: Register application in the registry

- [ ] Edit `src/interactions/registry.ts`:

```ts
import * as pagination from './pagination.js';
import * as loot from './loot.js';
import * as raider from './raider.js';
import * as trial from './trial.js';
import * as application from './application.js';

export const buttonHandlers: ButtonHandler[] = [
  ...pagination.buttons,
  ...loot.buttons,
  ...raider.buttons,
  ...trial.buttons,
  ...application.buttons,
];
export const modalHandlers: ModalHandler[] = [
  ...trial.modals,
  ...application.modals,
];
export const userSelectHandlers: UserSelectHandler[] = [
  ...raider.userSelects,
];
```

### Step 7.3: Remove application branches from interactionCreate.ts

- [ ] Edit `src/events/interactionCreate.ts`:

Delete from the button cascade:
- `// application:apply` block (lines ~150–164)
- `// application:edit:{applicationId}` block (lines ~166–186)
- `// application:confirm:{applicationId}` block (lines ~188–222)
- `// application:cancel:{applicationId}` block (lines ~224–245)
- `// application_vote:{type}:{applicationId}` block (lines ~247–253)
- `// application:accept:{applicationId}` block (lines ~255–258)
- `// application:reject:{applicationId}` block (lines ~260–263)

Delete from the modal cascade:
- `// application:modal:accept_message` block (lines ~556–567)
- `// application:modal:reject_message` block (lines ~569–581)
- `// application:modal:accept:{applicationId}` block (lines ~583–586)
- `// application:modal:reject:{applicationId}` block (lines ~588–591)

Remove now-unused imports at the top:
- `startApplication`, `submitApplication`, `activeSessions`, `enterEditMode`, `startSessionTimeout`
- `voteOnApplication`
- `acceptApplication`, `processAcceptModal`
- `rejectApplication`, `processRejectModal`
- `alertOfficers` from `auditLog` (verify no other use — `audit` import can also go if nothing else uses it)

### Step 7.4: Run tests and typecheck

- [ ] Run: `npm test && npx tsc --noEmit`
- [ ] Expected: PASS, no type errors.

### Step 7.5: Commit

- [ ] Run:

```bash
git add src/interactions/application.ts src/interactions/registry.ts src/events/interactionCreate.ts
git commit -m "refactor(interactions): migrate application buttons + modals to registry

application_vote keeps its underscore-prefix customId (persisted in
live voting embeds). The submit-error officer alert path (#42) is
preserved inside the confirm handler's own try/catch."
```

---

## Task 8: Final cleanup — remove old cascade scaffold

After task 7, every button/modal/userSelect is routed through the registry. The old try/catch cascades in `interactionCreate.ts` are empty. Remove the scaffolding and collapse the file to its final form.

**Files:**
- Modify: `src/events/interactionCreate.ts`
- Modify: `src/interactions/registry.ts`
- Modify: `tests/unit/interactions/dispatch.test.ts`

### Step 8.1: Rewrite interactionCreate.ts to its final shape

- [ ] Replace the entire contents of `src/events/interactionCreate.ts` with:

```ts
import type { Interaction } from 'discord.js';
import { MessageFlags } from 'discord.js';
import type { BotClient } from '../types/index.js';
import { logger } from '../services/logger.js';
import {
  buttonHandlers,
  modalHandlers,
  userSelectHandlers,
  dispatch,
} from '../interactions/registry.js';

export default {
  name: 'interactionCreate',
  async execute(...args: unknown[]) {
    const interaction = args[0] as Interaction;

    if (interaction.isChatInputCommand()) {
      const client = interaction.client as BotClient;
      const command = client.commands.get(interaction.commandName);

      if (!command) {
        logger.warn('interaction', `Unknown command: ${interaction.commandName}`);
        return;
      }

      try {
        await command.execute(interaction);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error('interaction', `Command ${interaction.commandName} failed: ${err.message}`, err);

        const reply = {
          content: 'There was an error executing this command.',
          flags: MessageFlags.Ephemeral,
        } as const;
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp(reply).catch(() => {});
        } else {
          await interaction.reply(reply).catch(() => {});
        }
      }
      return;
    }

    if (interaction.isButton()) {
      await dispatch(buttonHandlers, 'button', interaction, interaction.customId);
      return;
    }

    if (interaction.isUserSelectMenu()) {
      await dispatch(userSelectHandlers, 'select', interaction, interaction.customId);
      return;
    }

    if (interaction.isModalSubmit()) {
      await dispatch(modalHandlers, 'modal', interaction, interaction.customId);
      return;
    }
  },
};
```

### Step 8.2: Re-add Unhandled warning inside dispatch

Now that the cascade is gone, the dispatcher itself should log the warning when no handler matches (this is the behavior promised in the spec's architecture section). The return-true-if-handled contract stays the same.

- [ ] Edit `src/interactions/registry.ts` — update `dispatch`:

```ts
export async function dispatch<H extends AnyHandler, I extends AnyInteraction>(
  handlers: H[],
  kind: InteractionKind,
  interaction: I,
  customId: string,
): Promise<boolean> {
  const handler = handlers.find(
    h => customId === h.prefix || customId.startsWith(h.prefix + ':'),
  );

  if (!handler) {
    logger.warn('interaction', `Unhandled ${kind}: ${customId}`);
    return false;
  }

  if (handler.officerOnly && !(await requireOfficer(interaction, kind))) return true;

  const tail = customId === handler.prefix ? '' : customId.slice(handler.prefix.length + 1);
  const params = tail ? tail.split(':') : [];

  await wrapErrors(kind, customId, interaction, () =>
    (handler.handle as (i: I, p: string[]) => Promise<void>)(interaction, params),
  );
  return true;
}
```

### Step 8.3: Update the "no match" dispatch test

- [ ] Edit `tests/unit/interactions/dispatch.test.ts` — revise the unmatched test:

```ts
  it('logs a warning, returns false, and calls no handler when no prefix matches', async () => {
    const { logger } = await import('../../../src/services/logger.js');
    const result = await dispatch(handlers, 'button', stubInteraction(), 'unknown:id');
    expect(result).toBe(false);
    expect(handleA).not.toHaveBeenCalled();
    expect(handleB).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('interaction', expect.stringMatching(/Unhandled button: unknown:id/));
  });
```

### Step 8.4: Verify interactionCreate.ts is ~60 lines

- [ ] Run: `wc -l src/events/interactionCreate.ts`
- [ ] Expected: around 55–65 lines. (Spec target: ~60.)

### Step 8.5: Run full test suite and typecheck

- [ ] Run: `npm test && npx tsc --noEmit`
- [ ] Expected: PASS, no type errors.

### Step 8.6: Commit

- [ ] Run:

```bash
git add src/events/interactionCreate.ts src/interactions/registry.ts tests/unit/interactions/dispatch.test.ts
git commit -m "refactor(interactions): remove old cascade, final cleanup

interactionCreate.ts collapses to ~60 lines: dispatches chat commands
directly, buttons/modals/selects through the registry. Every handler
now lives in src/interactions/<domain>.ts."
```

---

## Task 9: Add prefix-collision test

Assert no two handlers in the same registry share a prefix-with-boundary overlap. Protects against future footguns.

**Files:**
- Create: `tests/unit/interactions/registry.test.ts`

### Step 9.1: Write the test

- [ ] Create `tests/unit/interactions/registry.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  buttonHandlers,
  modalHandlers,
  userSelectHandlers,
} from '../../../src/interactions/registry.js';

function assertNoCollisions(
  handlers: Array<{ prefix: string }>,
  kind: string,
): void {
  for (let i = 0; i < handlers.length; i++) {
    for (let j = i + 1; j < handlers.length; j++) {
      const a = handlers[i].prefix;
      const b = handlers[j].prefix;
      // Collision if they are equal OR one is a prefix-with-boundary of the other.
      const collides =
        a === b ||
        a.startsWith(b + ':') ||
        b.startsWith(a + ':');
      expect(
        collides,
        `${kind} prefix collision: "${a}" and "${b}"`,
      ).toBe(false);
    }
  }
}

describe('registry prefix collisions', () => {
  it('no two button handlers share a prefix-with-boundary overlap', () => {
    assertNoCollisions(buttonHandlers, 'button');
  });

  it('no two modal handlers share a prefix-with-boundary overlap', () => {
    assertNoCollisions(modalHandlers, 'modal');
  });

  it('no two user-select handlers share a prefix-with-boundary overlap', () => {
    assertNoCollisions(userSelectHandlers, 'userSelect');
  });
});
```

### Step 9.2: Run the test

- [ ] Run: `npm test -- tests/unit/interactions/registry.test.ts`
- [ ] Expected: PASS. If any collision appears, the error message identifies the two prefixes — fix by renaming one.

### Step 9.3: Run full suite one more time

- [ ] Run: `npm test`
- [ ] Expected: PASS — full suite green including the new test.

### Step 9.4: Commit

- [ ] Run:

```bash
git add tests/unit/interactions/registry.test.ts
git commit -m "test(interactions): assert no prefix-with-boundary collisions in registries"
```

---

## Task 10: Manual smoke test

Automated tests don't exercise real Discord interactions. Verify the refactor end-to-end before merge.

**Files:** none

### Step 10.1: Build and run against the dev guild

- [ ] Run: `npm run build` (or the equivalent build command from `package.json`)
- [ ] Run: `npm start` (or whichever start script connects the bot to the dev guild)
- [ ] Verify the bot logs in without errors.

### Step 10.2: Five-click smoke test

In the dev guild, click through each interaction kind once to prove the router path:

- [ ] **Pagination** — run any paginated command (e.g. `/raiders list`), click Next/Prev. Expected: page changes.
- [ ] **Loot button** — post a loot entry (or use an existing one), click a Major/Minor/Want In/Want Out button. Expected: post updates with the new responder.
- [ ] **Trial officer button** — on a trial review thread, click Extend (as an officer). Expected: "Trial extended by 1 week" reply, audit log entry.
- [ ] **Trial officer gate** — as a non-officer, click Extend on the same trial. Expected: ephemeral "You do not have permission to do this."
- [ ] **Application vote** — on an application voting embed, click a vote button. Expected: vote registers, embed updates.
- [ ] **Raider link confirm** — trigger the raider-linking flow (or use an existing pending link message), click Confirm. Expected: ephemeral "Linked X to @user!", message updates.

### Step 10.3: Verify log output

- [ ] Check the bot's stdout/logger output during smoke test. Expected: no `Unhandled button:` / `Unhandled modal:` / `Unhandled select:` warnings. Any such warning means a registered prefix doesn't match the live customId.

### Step 10.4: Open a PR

- [ ] If working in a feature branch, open a PR with link to this plan and spec. Smoke test results go in the PR description.

---

## Self-Review

**Spec coverage check:**
- Architecture (directory layout, dispatcher role): tasks 1, 2, 8 ✓
- Matching rule (exact OR prefix+colon): tasks 1.7, 9 ✓
- Three separate registries (kind-narrowed types): task 1.7 ✓
- Handler interface: task 1.7 ✓
- Middleware (`requireOfficer`, `wrapErrors`): task 1 ✓
- Registry wiring + domain module shape: tasks 3–7 ✓
- Dispatcher in interactionCreate.ts: tasks 2, 8 ✓
- Handler inventory (23 handlers across 5 domains): mapped in tasks 3–7 ✓
- `application_vote` underscore preservation: task 7.1 comment ✓
- Migration sequencing (pagination → loot → raider → trial → application): tasks 3–7 ✓
- Regression surface (customIds byte-identical, error messages unchanged, `alertOfficers` path preserved): preserved across all migration tasks ✓
- Testing infrastructure (`registry.test.ts`, `middleware.test.ts`, `dispatcher.test.ts`): tasks 1, 9 ✓
- Manual smoke test: task 10 ✓
- Deferred items (inline ModalBuilder, loot grouping, typed codecs, per-handler tests): respected — not touched ✓

**Placeholder scan:** No "TBD" / "implement later" / "add appropriate error handling" appear. Every step has concrete code or a concrete command.

**Type consistency:** `ButtonHandler` / `ModalHandler` / `UserSelectHandler` / `dispatch` signatures defined in task 1.7 match their usage in tasks 3–7. `InteractionKind` is exported from `middleware.ts` and imported in `registry.ts` (task 1).

**One fix applied inline:** Task 2.1 removes the `logger.warn('Unhandled...')` call from the dispatcher because during migration that would fire on every legacy-cascade-handled interaction. Task 8.2 re-adds it after the cascade is gone. Task 1.5's test expectation for the warn log was moved to task 8.3. This is consistent across tasks.

# interactionCreate.ts Refactor — Design Spec

Split the 691-line `src/events/interactionCreate.ts` into a thin dispatcher plus per-domain handler modules, with shared middleware for the officer role check and the error-wrap pattern. Pure structural refactor — no behavior change, no customId string changes, no error message changes.

**Context:** Today `interactionCreate.ts` is one function containing 23 button/modal/user-select handlers across 5 domains (raider, application, trial, loot, pagination). It has four copies of the officer role check, four copies of the error-wrap try/catch (one per interaction kind), magic-index `customId.split(':')[2]` parsing scattered throughout, and no clear extension point for new handlers. Adding a button means editing one long cascading file.

**Motivation:** Readability (file is too long to hold in context), testability (router logic is untested and handlers are hard to isolate), extensibility (new buttons require editing the router), and duplication (officer check + error wrap copy-pasted).

**Non-goals:**
- Redesigning how handlers work internally
- Moving business logic out of handler bodies (e.g. the loot-grouping logic that arguably belongs in `functions/loot/` — deferred)
- Introducing typed customId codecs — possible follow-up if future churn justifies it
- Writing per-handler unit tests — the refactor *enables* this but does not deliver it (23 handlers × a test each is a separate unit of work)

---

## Architecture

New directory `src/interactions/`:

```
src/interactions/
  registry.ts          exports buttonHandlers, modalHandlers, userSelectHandlers
  middleware.ts        requireOfficer(), wrapErrors()
  raider.ts            confirm_link, reject_link, ignore, select_user
  application.ts       apply, edit, confirm, cancel, application_vote, accept, reject,
                       modal:accept_message, modal:reject_message,
                       modal:accept:{id}, modal:reject:{id}
  trial.ts             update_info, extend, mark_promote, close,
                       modal:create, modal:update:{id}
  loot.ts              loot:{type}:{bossId}
  pagination.ts        page:{cmd}:{target}:{total}
```

`src/events/interactionCreate.ts` shrinks from 691 to ~60 lines. Responsibilities:

1. Chat command → look up `client.commands`, run with try/catch (unchanged from today)
2. Button / modal submit / user select → find matching handler in the right registry by `customId`, run through middleware
3. No match → `logger.warn('interaction', 'Unhandled <kind>: <customId>')` (new — today's code silently drops unmatched interactions)

**Matching rule:** a handler with prefix `P` matches `customId` iff `customId === P || customId.startsWith(P + ':')`. The boundary colon prevents unintended prefix overlap (e.g. a handler for `application:app` would not match customId `application:apply`).

**Three separate registries, not one unified:** button handlers can type-narrow `interaction` to `ButtonInteraction`, modal handlers to `ModalSubmitInteraction`, etc. — no casting inside handler bodies.

---

## Handler interface

Declared in `registry.ts`:

```ts
type ButtonHandler = {
  prefix: string;
  officerOnly?: boolean;
  handle(
    interaction: ButtonInteraction,
    params: string[],          // customId segments after the prefix, split by ':'
  ): Promise<void>;
};

type ModalHandler = {
  prefix: string;
  officerOnly?: boolean;
  handle(interaction: ModalSubmitInteraction, params: string[]): Promise<void>;
};

type UserSelectHandler = {
  prefix: string;
  officerOnly?: boolean;
  handle(interaction: UserSelectMenuInteraction, params: string[]): Promise<void>;
};
```

`params` is the trailing `:`-separated segments — e.g. customId `trial:extend:42` with prefix `trial:extend` yields `params = ['42']`. Handlers still do their own `parseInt` — no codec layer. Exact-match customIds (e.g. `application:apply`) yield `params = []`.

---

## Middleware

`middleware.ts`:

```ts
// Returns true if allowed. Replies ephemeral + returns false if gated.
requireOfficer(interaction, kind: 'button' | 'modal' | 'select'): Promise<boolean>

// Wraps handler call. On throw: logs with customId + kind + error, then replies
// or followUps ephemeral 'An error occurred handling this <kind>.' Handles the
// already-replied-or-deferred branching once.
wrapErrors(kind, customId, fn: () => Promise<void>): Promise<void>
```

**What stays in the handler body, not middleware:**
- `audit()` calls — handlers know what to log; middleware doesn't
- Success replies, `interaction.update()`, `showModal()`
- Non-officer gates (e.g. "user has a linked raider" in the loot handler)
- Handler-specific try/catch that produces a richer error message — e.g. `submitApplication`'s "saved as #42, officer notified" flow. `wrapErrors` is a last-resort net; domain-specific recovery paths keep their own inline try/catch.

---

## Registry wiring

`registry.ts`:

```ts
import * as raider      from './raider.js';
import * as application from './application.js';
import * as trial       from './trial.js';
import * as loot        from './loot.js';
import * as pagination  from './pagination.js';

export const buttonHandlers: ButtonHandler[] = [
  ...raider.buttons, ...application.buttons, ...trial.buttons,
  ...loot.buttons, ...pagination.buttons,
];
export const modalHandlers: ModalHandler[] = [
  ...application.modals, ...trial.modals,
];
export const userSelectHandlers: UserSelectHandler[] = [
  ...raider.userSelects,
];
```

Each domain module exports whichever of `buttons`, `modals`, `userSelects` it uses. Example `trial.ts`:

```ts
export const buttons: ButtonHandler[] = [
  { prefix: 'trial:update_info',  officerOnly: true, handle: updateInfo },
  { prefix: 'trial:extend',       officerOnly: true, handle: extend },
  { prefix: 'trial:mark_promote', officerOnly: true, handle: markPromote },
  { prefix: 'trial:close',        officerOnly: true, handle: close },
];

export const modals: ModalHandler[] = [
  { prefix: 'trial:modal:create', handle: modalCreate },
  { prefix: 'trial:modal:update', handle: modalUpdate },
];

async function updateInfo(interaction, params) { /* ... */ }
// etc.
```

---

## Dispatcher

In `interactionCreate.ts`:

```ts
async function dispatch<H extends { prefix: string; officerOnly?: boolean; handle: Function }>(
  handlers: H[],
  kind: 'button' | 'modal' | 'select',
  interaction,
  customId: string,
) {
  const handler = handlers.find(h =>
    customId === h.prefix || customId.startsWith(h.prefix + ':')
  );
  if (!handler) {
    logger.warn('interaction', `Unhandled ${kind}: ${customId}`);
    return;
  }
  if (handler.officerOnly && !(await requireOfficer(interaction, kind))) return;

  const tail = customId === handler.prefix ? '' : customId.slice(handler.prefix.length + 1);
  const params = tail ? tail.split(':') : [];

  await wrapErrors(kind, customId, () => handler.handle(interaction, params));
}
```

`handlers.find()` returns the first match. A unit test enforces no prefix-with-boundary overlap within a registry, so order cannot silently matter.

---

## Handler inventory

23 handlers across 3 kinds, mapped from the current 691-line file:

| Domain | Buttons | Modals | UserSelect |
|---|---|---|---|
| raider | `confirm_link`, `reject_link`, `ignore` | — | `select_user` |
| application | `apply`, `edit`, `confirm`, `cancel`, `application_vote`, `accept`, `reject` | `modal:accept_message`, `modal:reject_message`, `modal:accept:{id}`, `modal:reject:{id}` | — |
| trial | `update_info`, `extend`, `mark_promote`, `close` | `modal:create`, `modal:update:{id}` | — |
| loot | `loot:{type}:{bossId}` | — | — |
| pagination | `page:{cmd}:{target}:{total}` | — | — |

**Note:** `application_vote` uses an underscore, not `application:vote`. Preserve that customId exactly — it is persisted in live voting embeds and renaming would break them.

---

## Migration sequencing

1. Create `src/interactions/` with `registry.ts` (empty arrays) and `middleware.ts` (`requireOfficer`, `wrapErrors`). No behavior change; no registry entries yet.
2. Rewrite `interactionCreate.ts` to dispatch via the registry. With an empty registry, chat commands still work, but all buttons/modals/selects log `"Unhandled"`. **Do not ship this step alone** — it is broken in isolation. It lands in the same commit as step 3's first domain migration or is split across a commit pair within one PR.
3. Move one domain at a time: `pagination` first (smallest, one handler), then `loot`, `raider`, `trial`, `application`. After each domain moves, run the full test suite and smoke-verify that domain.
4. Remove now-unused imports from `interactionCreate.ts`.
5. Add the prefix-collision unit test (see Testing).

---

## Testing

**No behavior changes → the refactor's correctness is proven by existing tests continuing to pass.** New tests cover only the new infrastructure.

**New unit tests** under `tests/unit/interactions/`:

1. **`registry.test.ts`** — imports the populated registries and asserts that for every pair `(a, b)` within a registry, no prefix-with-boundary overlap exists (`a.prefix !== b.prefix && !a.prefix.startsWith(b.prefix + ':') && !b.prefix.startsWith(a.prefix + ':')`). Guards against future footguns.
2. **`middleware.test.ts`** — `requireOfficer` returns `true` for a member with the officer role, replies ephemeral + returns `false` without it; `wrapErrors` swallows throws, logs with customId/kind, and chooses `reply` vs `followUp` correctly based on `interaction.replied` / `interaction.deferred`.
3. **`dispatcher.test.ts`** — given a stub registry with two handlers: exact-match routes correctly; prefix+colon routes correctly; unmatched customId logs warn and returns without calling any handler; params are split correctly (`'trial:extend:42'` with prefix `'trial:extend'` → `['42']`; exact match → `[]`); `officerOnly: true` short-circuits when the gate fails.

**Existing tests that must keep passing unchanged:**

- `tests/unit/loot.test.ts`, `epgp.test.ts`, `applicationQuestions.test.ts`, `trialAlerts.test.ts`, `pagination.test.ts`, `autoMatchRaiders.test.ts`
- `tests/integration/applications-flow.test.ts`, `raids-flow.test.ts`

These exercise the functions the handlers call — the refactor does not touch them. If any break, the refactor broke something.

**Per-handler tests are deferred.** The new structure makes handlers individually testable; writing 23 handler tests is a separate unit of work.

**Manual smoke test before merge** — run the bot against the dev guild and click through: one pagination page, one loot priority button, one trial button, one application vote button, one raider link confirm. Five clicks cover all three interaction kinds plus the officer-gate and error-wrap middleware paths.

---

## Regression surface (things that must NOT change)

- Every customId string stays byte-identical — buttons on existing live messages (voting embeds, loot posts, trial threads, pagination cached pages) must keep working after the refactor ships
- Error message text shown to users stays identical
- Audit log entries stay identical (same actor, action, details)
- `submitApplication`'s handler-specific error path (alerts officers with the app ID) stays exactly as-is, inside the handler body, untouched by `wrapErrors`
- `activeSessions` (from `dmQuestionnaire.js`, used for DM application state) remains reachable from `application.ts` without circular imports

---

## Deferred / explicitly out of scope

- Extracting the inline `ModalBuilder` for `trial:update_info` into a helper function — nice-to-have, separate PR
- Moving the loot handler's inline raider-grouping logic (current lines 442–486) into `src/functions/loot/` — belongs there but is a separate refactor
- Typed customId codecs (the "approach C" option from brainstorming) — only worth it if future button churn creates pressure; revisit then
- Per-handler unit tests — enabled by this refactor, delivered later

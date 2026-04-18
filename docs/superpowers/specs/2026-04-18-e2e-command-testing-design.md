---
title: End-to-end command testing against a sandbox Discord guild
date: 2026-04-18
status: draft
---

# End-to-end command testing against a sandbox Discord guild

## Goal

Exercise every slash command, interactive component, scheduled job, and external integration of the bot against a real Discord guild, with a deterministic baseline so tests produce the same starting state on every run.

## Non-goals

- Replacing existing unit or integration tests. This suite sits alongside them.
- Covering Discord gateway event delivery itself (reconnection, shard resumes, etc.). Implicitly covered by the bot booting and responding at all.
- Running in CI on every push. The suite is intentionally heavy (real Discord + real external APIs) and is meant to be run on-demand before releases or when touching interaction plumbing.

## Approach summary

The harness boots the bot's real `discord.js` client against a dedicated sandbox guild, then synthesizes `Interaction` objects in-process and calls the bot's existing command handlers directly. Side-effects that the bot makes through `channel.send`, `thread.create`, `message.edit`, `member.roles.add`, etc. hit real Discord. External API calls to raider.io and wowaudit are made for real.

Methods that handlers call *on the interaction itself* (`reply`, `deferReply`, `editReply`, `followUp`, `showModal`, `update`) are recorded by the fake interaction for assertions — except for a small set (`update` on buttons, `followUp` when used as a channel post) which are piped to real `message.edit` / `channel.send` so the real guild state reflects what a user would see.

Baseline reset uses the bot's own `/testdata reset confirm:true` followed by `/testdata seed_all discord:true`, invoked via the same synthesizer — no new reset mechanism.

## Architecture

```
┌─────────────────────────────────┐    ┌──────────────────────┐
│  vitest runner (project "e2e")  │    │ sandbox Discord guild │
│  tests/e2e/**/*.ts              │    │  fixed scaffold       │
│                                 │    │  (channels, roles,    │
│  ┌──────────────────────────┐   │    │   tester members)     │
│  │ e2e harness              │   │    └──────────┬───────────┘
│  │  - bootstrap bot client  │◄──┼── real gateway│
│  │  - resetAndSeed()        │   │   connection  │
│  │  - fakeChatInput/        │   │               │
│  │    fakeButton/           │   │               │
│  │    fakeModalSubmit       │   │               │
│  │  - assertDB/assertGuild  │   │               │
│  └──────────┬───────────────┘   │               │
│             │                   │               │
│   synthesizes Interaction,      │               │
│   calls command.execute()       │               │
│             ▼                   │               │
│  ┌──────────────────────────┐   │               │
│  │ bot command handlers     │───┼───────────────┘
│  │ (unchanged production    │   │  real discord.js
│  │  code paths)             │   │  side-effects
│  └──────────────────────────┘   │   (post/thread/role/edit)
└─────────────────────────────────┘
```

Four moving parts:

1. **Sandbox guild** — dedicated Discord server. Fixed channel/role/member scaffold. Never recreated by tests. Referenced by IDs in `.env.test`.
2. **Live `discord.js` Client** — the harness boots a single real `Client` with the bot's test token. Logs in once per suite run, caches guild/channels/roles/members, logs out at suite end.
3. **Interaction synthesizer** — a helper module that constructs fake `Interaction` objects against the live client and calls handlers directly.
4. **Tests (vitest)** — one file per command, plus flow files for multi-step behaviors.

## Components

### Sandbox guild scaffold

The guild must be pre-provisioned once (manually or via a one-off setup script) and then left alone. It contains:

- All channels the bot's `/setup` and runtime logic expect (raider-setup, applications forum, trial-review forum, loot, logs, etc.).
- All roles the bot assigns (raider, trial, officer, etc.).
- At least three *tester* member accounts: `TESTER_PRIMARY`, `VOTER_A`, `VOTER_B`. Each is a real Discord user that has joined the sandbox guild. Their user IDs are stored in `.env.test`.
- One *officer* member account for permission-gated commands.

Tests do not mutate channel structure or role definitions. They only mutate content inside channels (messages, threads), role assignments on members, and the SQLite DB.

### `tests/e2e/setup/bootstrap.ts`

- Loads `.env.test`.
- Instantiates a `discord.js` `Client` with the same intents the production bot uses.
- `client.login(DISCORD_TOKEN_TEST)`.
- Waits for `ready`, fetches the sandbox guild, caches references to the channels, roles, and tester members the tests will need.
- Exports `client`, `guild`, `channels`, `roles`, `members`.
- Registers a `globalTeardown` that logs the client out cleanly.

### `tests/e2e/setup/synthesizer.ts`

Exposes three factories:

```ts
fakeChatInput({
  commandName: string,
  subcommand?: string,
  options?: Record<string, string | number | boolean | User | Channel | Role>,
  user?: User,          // defaults to TESTER_PRIMARY
  channel?: TextBasedChannel,
}): FakeChatInputCommandInteraction

fakeButton({
  customId: string,
  message: Message,     // a real Message fetched from the sandbox guild
  user?: User,
}): FakeButtonInteraction

fakeModalSubmit({
  customId: string,
  fields: Record<string, string>,
  user?: User,
  channel?: TextBasedChannel,
}): FakeModalSubmitInteraction
```

Each fake exposes:

- The full set of properties handlers read (`commandName`, `options`, `customId`, `user`, `member`, `guild`, `channel`, `client`, `message` for components, `fields` for modals).
- A recording set of methods: `reply`, `deferReply`, `editReply`, `followUp`, `showModal`, `update`, `deferUpdate`. Calls are stored on the fake object under `__replies`, `__deferred`, `__editedReply`, `__followUps`, `__modalShown`, `__updated`.
- For `FakeButtonInteraction.update`, the call additionally translates to `message.edit(payload)` so the real message changes (matching what a real user click would cause).
- For `followUp` used as a channel post (detected by absence of `flags: Ephemeral`), pipe through `channel.send(payload)` so the real channel reflects the post.
- `options` is a thin shim that implements the methods handlers use: `getSubcommand`, `getString`, `getInteger`, `getBoolean`, `getUser`, `getChannel`, `getRole`, `getMember`, `getAttachment`. Not a full `CommandInteractionOptionResolver`.
- `fields` is a shim with `getTextInputValue(customId)` only.

Handlers will be called with `fake as unknown as ChatInputCommandInteraction` (or the relevant type). The synthesizer is a pragmatic subset, not a full implementation. Any call to an unimplemented method throws `SynthesizerError("not implemented: <method> — extend synthesizer.ts")` so tests fail loudly and we extend on demand.

### `tests/e2e/setup/baseline.ts`

```ts
resetAndSeed(): Promise<void>
```

Synthesizes `/testdata reset confirm:true` then `/testdata seed_all discord:true`, each invoked as the `OFFICER` user (since `/testdata` is gated by `requireOfficer`). Waits for both to complete before returning.

Invoked in `beforeEach` of every test file.

### `tests/e2e/setup/users.ts`

Exports `TESTER_PRIMARY`, `VOTER_A`, `VOTER_B`, `OFFICER` as fully-populated discord.js `User`/`GuildMember` references fetched during bootstrap.

### `tests/e2e/setup/assertions.ts`

Helpers that keep tests concise:

- `db.query(sql, params)` — opens a readonly connection to the test SQLite DB.
- `assertRow(table, where)` / `assertNoRow(table, where)`.
- `assertChannelHasMessage(channel, predicate)` — fetches recent messages and asserts one matches.
- `assertThreadExists(parentChannel, name)`.
- `assertMemberHasRole(member, role)` / `assertMemberLacksRole(...)`.

### Test files

One file per command (`tests/e2e/commands/*.e2e.ts`), plus flow files for behaviors that span multiple commands or require interactive sequences (`tests/e2e/flows/*.e2e.ts`).

Command files cover every subcommand and every meaningful option combination. Flow files cover:

- `applications-vote.e2e.ts` — post app, multiple voters click vote buttons, assert state transitions and role changes.
- `apply-modal.e2e.ts` — `/apply` flow, DM question/answer sequence, submission lands in forum.
- `loot-award.e2e.ts` — loot post, claim buttons, EPGP update.
- `trial-alerts.e2e.ts` — direct-invoke the scheduled alert function, assert trial-review post.
- `epgp-decay.e2e.ts` — direct-invoke decay, assert DB deltas.
- `backup.e2e.ts` — direct-invoke backup, assert file written.
- `dm-resume.e2e.ts` — mid-apply interruption, resume.
- `thread-keep-alive.e2e.ts` — direct-invoke keep-alive, assert thread not archived.

### Scheduled jobs

The bot registers cron-driven functions in `src/services/scheduler.ts`. Tests bypass `node-cron` and call those functions directly with the live client/guild references. This matches the pattern already used in `tests/unit/scheduler.test.ts` and `tests/unit/trialAlerts.test.ts`.

### External APIs (raider.io, wowaudit)

Per the design choice to exercise full fidelity, these are called for real during e2e runs. Consequences accepted:

- Network flakiness can fail tests through no fault of the bot.
- Rate limits and API-key limits apply.
- API tokens for the external services go in `.env.test`.

Each e2e file that depends on an external API annotates `// requires: raider.io` in a header comment so we can grep for them if we need to skip that subset during an outage.

## Execution model

### vitest project

`vitest.config.e2e.ts` defines an `e2e` project that:

- Points at `tests/e2e/**/*.e2e.ts` only.
- Sets `test.sequence.concurrent = false` and `test.fileParallelism = false` — the suite shares one sandbox guild; parallel runs would collide.
- Uses a longer timeout (default 60s per test, overridable) because real Discord + real external APIs are slow.
- `globalSetup` boots the client once; `globalTeardown` logs it out.

### Scripts

```json
{
  "test:e2e": "vitest run --project e2e",
  "test:e2e:watch": "vitest --project e2e"
}
```

`npm test` continues to run only unit + integration. `test:e2e` is manual.

### Lifecycle per test file

```
beforeAll (per project) : bootstrap client, cache scaffold
beforeEach              : resetAndSeed()
test                    : synthesize interactions, assert
afterAll (per project)  : logout client
```

### Environment

`.env.test` (gitignored):

```
DISCORD_TOKEN_TEST=...
SANDBOX_GUILD_ID=...
TESTER_PRIMARY_ID=...
VOTER_A_ID=...
VOTER_B_ID=...
OFFICER_ID=...
TEST_DB_PATH=./tests/e2e/.data/test.db
RAIDERIO_API_KEY=...
WOWAUDIT_API_KEY=...
```

Test DB is a separate SQLite file; `resetAndSeed` wipes it. Tests never touch the production DB.

### Expected runtime

Minutes for a full suite, not seconds. Acceptable — this is a pre-release/change-plumbing safety net, not a per-push gate.

## Assertion style

- DB-first: each test opens the test SQLite DB and runs focused queries. Most assertions live there.
- Discord-side reads second: only when the DB cannot tell the story (e.g., "did the loot embed actually render", "did the forum thread get created with the expected title"). Use the cached guild reference to fetch and inspect.
- Recorded interaction methods third: assert the handler called `reply` with the expected embed/content for behaviors where the user-visible reply is the contract.

## Risks and iteration points

- **Synthesizer fidelity**. The first version will not cover every method handlers call. Any unimplemented method throws a clear error; we extend the synthesizer when a test hits it. Expect a short period of "add method X to synthesizer" churn as we bring commands online.
- **Modal + submit chaining**. Handlers that `showModal` and later receive the `ModalSubmit` as a separate interaction need tests that synthesize both in sequence. The synthesizer does not auto-route between them; the test orchestrates.
- **Pagination and collectors**. Commands that use `MessageComponentCollector` (e.g., `/raiders get_raiders` pagination) rely on real component events. Options: (a) wait briefly for the collector to arm, then have the test synthesize the component interaction and dispatch it to the collector by constructing it against the real message; (b) expose testing hooks in the pagination util. Choose (a) first; if brittle, add a narrow hook.
- **Rate limits on real Discord**. A full run does many posts/edits/role changes. If we hit 429s, slow the suite with a small inter-test delay or batch cleanup.
- **External API flakiness**. Accepted per design; mitigated by running the suite on-demand, not on every push.
- **Sandbox guild drift**. If the scaffold gets edited by hand, tests may fail mysteriously. Document the scaffold and add a `verifyScaffold()` check in `beforeAll` that fails fast with a clear message if something is missing.

## Out of scope

- Gateway reconnection, shard behavior, or any Discord-infrastructure behavior not reachable through interactions.
- CI integration. This suite is local/manual.
- Load or performance testing.
- UI snapshot tests against the Discord web client.

## Open questions to resolve during implementation

- Exact list of tester member IDs needed beyond the three named above (some flows may need four or five).
- Whether the test DB should be committed as a golden seed or always rebuilt from `seedAll`. Default: always rebuild.
- Whether `verifyScaffold()` is worth the engineering cost in v1 or deferred.

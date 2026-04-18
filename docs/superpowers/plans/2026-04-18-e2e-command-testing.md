# End-to-End Command Testing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an end-to-end test harness that exercises every slash command, interactive component, scheduled job, and external integration against a real Discord sandbox guild with a deterministic per-test baseline.

**Architecture:** A new vitest project (`e2e`) boots a real `discord.js` Client against a sandbox guild, synthesizes fake `Interaction` objects in-process, and calls the bot's unchanged command handlers directly. Side-effects (channel posts, thread creates, role assignments, message edits) go to real Discord. `/testdata reset confirm:true` + `/testdata seed_all discord:true` run in `beforeEach` as the per-test baseline. External APIs (raider.io, wowaudit) are called for real.

**Tech Stack:** TypeScript, Node 22+, vitest 4, discord.js 14, better-sqlite3, existing `/testdata` seed machinery.

**Spec:** `docs/superpowers/specs/2026-04-18-e2e-command-testing-design.md`.

---

## File Structure

### Created
- `.env.test.example` — documented template of required test env vars.
- `vitest.config.ts` — modified to define the `e2e` project (alongside existing default).
- `tests/e2e/.data/.gitkeep` — holder for runtime test DB.
- `tests/e2e/setup/env.ts` — typed loader/validator for `.env.test`.
- `tests/e2e/setup/db.ts` — opens the test SQLite DB (readonly for assertions, read-write for baseline).
- `tests/e2e/setup/bootstrap.ts` — boots the real client, logs in, caches guild + tester members (`TESTER_PRIMARY`, `VOTER_A`, `VOTER_B`, `OFFICER`). Exposes them via `getE2EContext()`. (The spec's separate `users.ts` is merged here; a dedicated file would just re-export.)
- `tests/e2e/setup/verifyScaffold.ts` — fail-fast check that required channels/roles/members exist.
- `tests/e2e/setup/synthesizer.ts` — `fakeChatInput` / `fakeButton` / `fakeModalSubmit` factories + recording scaffolding.
- `tests/e2e/setup/baseline.ts` — `resetAndSeed()` that invokes `/testdata reset` + `/testdata seed_all discord:true` through the synthesizer.
- `tests/e2e/setup/assertions.ts` — DB query + guild read helpers.
- `tests/e2e/setup/globalSetup.ts` — vitest global setup/teardown (boot + logout + scaffold check).
- `tests/e2e/commands/*.e2e.ts` — one file per slash command.
- `tests/e2e/flows/*.e2e.ts` — multi-step flow tests.
- `tests/unit/e2e-setup/*.test.ts` — unit tests for pure helpers (env, synthesizer options shim).
- `docs/superpowers/runbook/e2e-scaffold-setup.md` — manual sandbox-guild provisioning runbook.

### Modified
- `.gitignore` — add `.env.test` and `tests/e2e/.data/`.
- `package.json` — add `test:e2e` + `test:e2e:watch` scripts.
- `vitest.config.ts` — split into default and `e2e` projects.

---

## Task 1: Infrastructure — gitignore, env template, test data dir

**Files:**
- Modify: `.gitignore`
- Create: `.env.test.example`
- Create: `tests/e2e/.data/.gitkeep`

- [ ] **Step 1: Update `.gitignore`**

Append to `.gitignore`:

```
.env.test
tests/e2e/.data/
!tests/e2e/.data/.gitkeep
```

- [ ] **Step 2: Create the data dir placeholder**

Create empty file `tests/e2e/.data/.gitkeep`.

- [ ] **Step 3: Create `.env.test.example`**

```
# Copy to .env.test and fill in real values.
# .env.test is gitignored — never commit real tokens.

DISCORD_TOKEN_TEST=
SANDBOX_GUILD_ID=

# Sandbox member IDs — each must be a user who has joined SANDBOX_GUILD_ID.
TESTER_PRIMARY_ID=
VOTER_A_ID=
VOTER_B_ID=
OFFICER_ID=

# Channel IDs the bot's production code expects to find configured.
# Provision the sandbox guild with the standard scaffold then paste IDs here.
# See docs/superpowers/runbook/e2e-scaffold-setup.md for the full list.

# Path for the per-run test SQLite DB. Wiped by resetAndSeed().
TEST_DB_PATH=./tests/e2e/.data/test.db

# External APIs called for real during e2e.
RAIDERIO_API_KEY=
WOWAUDIT_API_KEY=
```

- [ ] **Step 4: Commit**

```bash
git add .gitignore .env.test.example tests/e2e/.data/.gitkeep
git commit -m "test(e2e): scaffold gitignore, env template, data dir"
```

---

## Task 2: Vitest e2e project config + scripts

**Files:**
- Modify: `vitest.config.ts`
- Modify: `package.json`

- [ ] **Step 1: Rewrite `vitest.config.ts` with two projects**

Replace entire contents with:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'default',
          include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['tests/e2e/**/*.e2e.ts'],
          environment: 'node',
          fileParallelism: false,
          sequence: { concurrent: false },
          testTimeout: 60_000,
          hookTimeout: 120_000,
          globalSetup: ['tests/e2e/setup/globalSetup.ts'],
        },
      },
    ],
  },
});
```

- [ ] **Step 2: Add scripts to `package.json`**

In the `scripts` block, after `"test:integration"`, add:

```json
"test:e2e": "vitest run --project e2e",
"test:e2e:watch": "vitest --project e2e",
```

- [ ] **Step 3: Verify default tests still pass**

Run: `npm test`
Expected: all existing unit + integration tests pass (we've only added config).

- [ ] **Step 4: Verify e2e project resolves (no tests yet)**

Run: `npm run test:e2e`
Expected: vitest reports "No test files found" for the `e2e` project (the glob `tests/e2e/**/*.e2e.ts` matches nothing). Command exits non-zero, but the output shows the project is wired correctly. This is OK for now.

- [ ] **Step 5: Commit**

```bash
git add vitest.config.ts package.json
git commit -m "test(e2e): add vitest e2e project and scripts"
```

---

## Task 3: `tests/e2e/setup/env.ts` — typed env loader

**Files:**
- Create: `tests/e2e/setup/env.ts`
- Test: `tests/unit/e2e-setup/env.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/e2e-setup/env.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { loadE2EEnv } from '../../../src/../tests/e2e/setup/env.js';

describe('loadE2EEnv', () => {
  beforeEach(() => {
    for (const k of [
      'DISCORD_TOKEN_TEST', 'SANDBOX_GUILD_ID',
      'TESTER_PRIMARY_ID', 'VOTER_A_ID', 'VOTER_B_ID', 'OFFICER_ID',
      'TEST_DB_PATH', 'RAIDERIO_API_KEY', 'WOWAUDIT_API_KEY',
    ]) delete process.env[k];
  });

  it('throws a clear error when required keys are missing', () => {
    expect(() => loadE2EEnv()).toThrow(/missing required e2e env vars/i);
  });

  it('returns a typed object when all keys are present', () => {
    process.env.DISCORD_TOKEN_TEST = 'token';
    process.env.SANDBOX_GUILD_ID = '1';
    process.env.TESTER_PRIMARY_ID = '2';
    process.env.VOTER_A_ID = '3';
    process.env.VOTER_B_ID = '4';
    process.env.OFFICER_ID = '5';
    process.env.TEST_DB_PATH = './tmp.db';
    process.env.RAIDERIO_API_KEY = 'r';
    process.env.WOWAUDIT_API_KEY = 'w';
    const env = loadE2EEnv();
    expect(env.sandboxGuildId).toBe('1');
    expect(env.testDbPath).toBe('./tmp.db');
  });
});
```

Since vitest's default project excludes `tests/e2e/` but INCLUDES `tests/unit/**/*.test.ts`, this unit test will run under the default project.

- [ ] **Step 2: Run the test, expect failure**

Run: `npm test -- tests/unit/e2e-setup/env.test.ts`
Expected: FAIL — module `tests/e2e/setup/env.js` does not exist.

- [ ] **Step 3: Create `tests/e2e/setup/env.ts`**

```ts
import { config as loadDotenv } from 'dotenv';

const REQUIRED_KEYS = [
  'DISCORD_TOKEN_TEST',
  'SANDBOX_GUILD_ID',
  'TESTER_PRIMARY_ID',
  'VOTER_A_ID',
  'VOTER_B_ID',
  'OFFICER_ID',
  'TEST_DB_PATH',
  'RAIDERIO_API_KEY',
  'WOWAUDIT_API_KEY',
] as const;

type Key = (typeof REQUIRED_KEYS)[number];

export interface E2EEnv {
  discordToken: string;
  sandboxGuildId: string;
  testerPrimaryId: string;
  voterAId: string;
  voterBId: string;
  officerId: string;
  testDbPath: string;
  raiderioApiKey: string;
  wowauditApiKey: string;
}

let cached: E2EEnv | null = null;

export function loadE2EEnv(): E2EEnv {
  if (cached) return cached;

  loadDotenv({ path: '.env.test' });

  const missing: Key[] = [];
  for (const key of REQUIRED_KEYS) {
    if (!process.env[key]) missing.push(key);
  }
  if (missing.length > 0) {
    throw new Error(`missing required e2e env vars: ${missing.join(', ')}`);
  }

  cached = {
    discordToken: process.env.DISCORD_TOKEN_TEST!,
    sandboxGuildId: process.env.SANDBOX_GUILD_ID!,
    testerPrimaryId: process.env.TESTER_PRIMARY_ID!,
    voterAId: process.env.VOTER_A_ID!,
    voterBId: process.env.VOTER_B_ID!,
    officerId: process.env.OFFICER_ID!,
    testDbPath: process.env.TEST_DB_PATH!,
    raiderioApiKey: process.env.RAIDERIO_API_KEY!,
    wowauditApiKey: process.env.WOWAUDIT_API_KEY!,
  };
  return cached;
}

export function resetE2EEnvCache(): void {
  cached = null;
}
```

- [ ] **Step 4: Update the unit test to reset the cache**

Add `resetE2EEnvCache()` to `beforeEach` in `tests/unit/e2e-setup/env.test.ts`:

```ts
import { loadE2EEnv, resetE2EEnvCache } from '../../../tests/e2e/setup/env.js';
// ...
beforeEach(() => {
  resetE2EEnvCache();
  for (const k of [...]) delete process.env[k];
});
```

- [ ] **Step 5: Run the test, expect pass**

Run: `npm test -- tests/unit/e2e-setup/env.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/setup/env.ts tests/unit/e2e-setup/env.test.ts
git commit -m "test(e2e): add typed env loader with validation"
```

---

## Task 4: `tests/e2e/setup/db.ts` — test DB helper

**Files:**
- Create: `tests/e2e/setup/db.ts`

Note: no unit test — this is a thin wrapper around `better-sqlite3` and `fs`. Covered by the first e2e test that exercises it end-to-end.

- [ ] **Step 1: Create `tests/e2e/setup/db.ts`**

```ts
import Database from 'better-sqlite3';
import { existsSync, unlinkSync } from 'fs';
import { loadE2EEnv } from './env.js';

export function testDbPath(): string {
  return loadE2EEnv().testDbPath;
}

export function wipeTestDb(): void {
  const path = testDbPath();
  if (existsSync(path)) unlinkSync(path);
}

export function openTestDbReadonly(): Database.Database {
  return new Database(testDbPath(), { readonly: true, fileMustExist: true });
}
```

- [ ] **Step 2: Commit**

```bash
git add tests/e2e/setup/db.ts
git commit -m "test(e2e): add test db open/wipe helper"
```

---

## Task 5: `tests/e2e/setup/synthesizer.ts` — options shim (unit-testable core)

**Files:**
- Create: `tests/e2e/setup/synthesizer.ts`
- Test: `tests/unit/e2e-setup/synthesizer-options.test.ts`

- [ ] **Step 1: Write failing tests for the options shim**

Create `tests/unit/e2e-setup/synthesizer-options.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildOptionsShim } from '../../../tests/e2e/setup/synthesizer.js';

describe('buildOptionsShim', () => {
  it('returns subcommand from the values map', () => {
    const opts = buildOptionsShim({ subcommand: 'seed_raiders', values: {} });
    expect(opts.getSubcommand()).toBe('seed_raiders');
  });

  it('throws when getSubcommand called without one set', () => {
    const opts = buildOptionsShim({ values: {} });
    expect(() => opts.getSubcommand()).toThrow(/no subcommand/i);
  });

  it('returns strings, ints, booleans', () => {
    const opts = buildOptionsShim({
      values: { name: 'foo', count: 3, discord: true },
    });
    expect(opts.getString('name')).toBe('foo');
    expect(opts.getInteger('count')).toBe(3);
    expect(opts.getBoolean('discord')).toBe(true);
  });

  it('returns null for missing non-required options', () => {
    const opts = buildOptionsShim({ values: {} });
    expect(opts.getString('missing')).toBeNull();
    expect(opts.getBoolean('missing')).toBeNull();
  });

  it('throws when required option is missing', () => {
    const opts = buildOptionsShim({ values: {} });
    expect(() => opts.getString('missing', true)).toThrow(/required option/i);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npm test -- tests/unit/e2e-setup/synthesizer-options.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `tests/e2e/setup/synthesizer.ts` with the options shim**

```ts
export interface OptionsShimInit {
  subcommand?: string;
  values: Record<string, string | number | boolean | unknown>;
}

export interface OptionsShim {
  getSubcommand(required?: boolean): string;
  getString(name: string, required?: boolean): string | null;
  getInteger(name: string, required?: boolean): number | null;
  getBoolean(name: string, required?: boolean): boolean | null;
  getUser(name: string, required?: boolean): unknown;
  getMember(name: string): unknown;
  getChannel(name: string, required?: boolean): unknown;
  getRole(name: string, required?: boolean): unknown;
  getAttachment(name: string, required?: boolean): unknown;
}

export function buildOptionsShim(init: OptionsShimInit): OptionsShim {
  const get = <T>(name: string, required: boolean | undefined, typeLabel: string): T | null => {
    const v = init.values[name];
    if (v === undefined || v === null) {
      if (required) throw new Error(`required option "${name}" (${typeLabel}) not provided`);
      return null;
    }
    return v as T;
  };

  return {
    getSubcommand(required = true) {
      if (!init.subcommand) {
        if (required) throw new Error('no subcommand set on options shim');
        return '';
      }
      return init.subcommand;
    },
    getString: (n, r) => get<string>(n, r, 'string'),
    getInteger: (n, r) => get<number>(n, r, 'integer'),
    getBoolean: (n, r) => get<boolean>(n, r, 'boolean'),
    getUser: (n, r) => get(n, r, 'user'),
    getMember: (n) => get(n, false, 'member'),
    getChannel: (n, r) => get(n, r, 'channel'),
    getRole: (n, r) => get(n, r, 'role'),
    getAttachment: (n, r) => get(n, r, 'attachment'),
  };
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npm test -- tests/unit/e2e-setup/synthesizer-options.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/setup/synthesizer.ts tests/unit/e2e-setup/synthesizer-options.test.ts
git commit -m "test(e2e): synthesizer options shim"
```

---

## Task 6: `synthesizer.ts` — `fakeChatInput` factory

**Files:**
- Modify: `tests/e2e/setup/synthesizer.ts`

This factory depends on a live `Client`/`Guild` at runtime, so it is not meaningfully unit-testable in isolation. It will be exercised by the first smoke test (Task 16).

- [ ] **Step 1: Append to `tests/e2e/setup/synthesizer.ts`**

```ts
import type {
  Client, Guild, GuildMember, TextBasedChannel, User,
  InteractionReplyOptions, InteractionEditReplyOptions,
  ModalBuilder,
} from 'discord.js';
import { MessageFlags } from 'discord.js';

export interface FakeReply {
  options: InteractionReplyOptions | string;
  ephemeral: boolean;
}

export interface FakeChatInputInit {
  client: Client;
  guild: Guild;
  channel: TextBasedChannel;
  member: GuildMember;
  user: User;
  commandName: string;
  subcommand?: string;
  options?: Record<string, unknown>;
}

export interface FakeChatInput {
  type: 'chatInput';
  client: Client;
  guild: Guild;
  channel: TextBasedChannel;
  member: GuildMember;
  user: User;
  commandName: string;
  options: OptionsShim;
  createdTimestamp: number;
  deferred: boolean;
  replied: boolean;

  // recordings
  __replies: FakeReply[];
  __deferred: { ephemeral: boolean } | null;
  __editedReply: FakeReply | null;
  __followUps: FakeReply[];
  __modalShown: ModalBuilder | null;

  // discord.js-shaped methods
  reply(opts: InteractionReplyOptions | string): Promise<unknown>;
  deferReply(opts?: { flags?: number }): Promise<unknown>;
  editReply(opts: InteractionEditReplyOptions | string): Promise<unknown>;
  followUp(opts: InteractionReplyOptions | string): Promise<unknown>;
  showModal(modal: ModalBuilder): Promise<void>;
  fetchReply(): Promise<unknown>;
}

function isEphemeral(opts: InteractionReplyOptions | string): boolean {
  if (typeof opts === 'string') return false;
  const flags = opts.flags;
  if (typeof flags === 'number') return (flags & MessageFlags.Ephemeral) !== 0;
  return false;
}

export function fakeChatInput(init: FakeChatInputInit): FakeChatInput {
  const fake: FakeChatInput = {
    type: 'chatInput',
    client: init.client,
    guild: init.guild,
    channel: init.channel,
    member: init.member,
    user: init.user,
    commandName: init.commandName,
    options: buildOptionsShim({
      subcommand: init.subcommand,
      values: init.options ?? {},
    }),
    createdTimestamp: Date.now(),
    deferred: false,
    replied: false,
    __replies: [],
    __deferred: null,
    __editedReply: null,
    __followUps: [],
    __modalShown: null,

    async reply(opts) {
      fake.__replies.push({ options: opts, ephemeral: isEphemeral(opts) });
      fake.replied = true;
      // withResponse-shaped return: callers use response.resource?.message?.createdTimestamp
      return { resource: { message: { createdTimestamp: Date.now() } } };
    },
    async deferReply(opts) {
      fake.__deferred = {
        ephemeral: (opts?.flags ?? 0) === MessageFlags.Ephemeral,
      };
      fake.deferred = true;
      return undefined;
    },
    async editReply(opts) {
      fake.__editedReply = { options: opts as InteractionReplyOptions, ephemeral: false };
      return { id: 'fake-edited-reply' };
    },
    async followUp(opts) {
      const ephemeral = isEphemeral(opts);
      fake.__followUps.push({ options: opts, ephemeral });
      // If non-ephemeral, pipe to channel.send so real Discord reflects it.
      if (!ephemeral && init.channel.isSendable()) {
        const payload = typeof opts === 'string' ? { content: opts } : opts;
        await init.channel.send(payload as Parameters<typeof init.channel.send>[0]);
      }
      return { id: 'fake-follow-up' };
    },
    async showModal(modal) {
      fake.__modalShown = modal;
    },
    async fetchReply() {
      return { id: 'fake-reply' };
    },
  };
  return fake;
}
```

- [ ] **Step 2: Build the project to catch type errors**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/setup/synthesizer.ts
git commit -m "test(e2e): fakeChatInput factory with recording + real followUp"
```

---

## Task 7: `synthesizer.ts` — `fakeButton` factory

**Files:**
- Modify: `tests/e2e/setup/synthesizer.ts`

- [ ] **Step 1: Append to `tests/e2e/setup/synthesizer.ts`**

```ts
import type { Message, MessageEditOptions } from 'discord.js';

export interface FakeButtonInit {
  client: Client;
  guild: Guild;
  channel: TextBasedChannel;
  member: GuildMember;
  user: User;
  message: Message;
  customId: string;
}

export interface FakeButton {
  type: 'button';
  client: Client;
  guild: Guild;
  channel: TextBasedChannel;
  member: GuildMember;
  user: User;
  message: Message;
  customId: string;
  createdTimestamp: number;
  deferred: boolean;
  replied: boolean;

  __replies: FakeReply[];
  __deferredUpdate: boolean;
  __updated: MessageEditOptions | null;
  __followUps: FakeReply[];

  reply(opts: InteractionReplyOptions | string): Promise<unknown>;
  deferReply(opts?: { flags?: number }): Promise<unknown>;
  deferUpdate(): Promise<unknown>;
  update(opts: MessageEditOptions | string): Promise<unknown>;
  followUp(opts: InteractionReplyOptions | string): Promise<unknown>;
}

export function fakeButton(init: FakeButtonInit): FakeButton {
  const fake: FakeButton = {
    type: 'button',
    client: init.client,
    guild: init.guild,
    channel: init.channel,
    member: init.member,
    user: init.user,
    message: init.message,
    customId: init.customId,
    createdTimestamp: Date.now(),
    deferred: false,
    replied: false,
    __replies: [],
    __deferredUpdate: false,
    __updated: null,
    __followUps: [],

    async reply(opts) {
      fake.__replies.push({ options: opts, ephemeral: isEphemeral(opts) });
      fake.replied = true;
      return { resource: { message: { createdTimestamp: Date.now() } } };
    },
    async deferReply(opts) {
      fake.deferred = true;
      return undefined;
    },
    async deferUpdate() {
      fake.__deferredUpdate = true;
      return undefined;
    },
    async update(opts) {
      const payload = typeof opts === 'string' ? { content: opts } : opts;
      fake.__updated = payload;
      // Pipe to real message.edit so the sandbox guild reflects the change.
      await init.message.edit(payload);
      return undefined;
    },
    async followUp(opts) {
      const ephemeral = isEphemeral(opts);
      fake.__followUps.push({ options: opts, ephemeral });
      if (!ephemeral && init.channel.isSendable()) {
        const payload = typeof opts === 'string' ? { content: opts } : opts;
        await init.channel.send(payload as Parameters<typeof init.channel.send>[0]);
      }
      return { id: 'fake-follow-up' };
    },
  };
  return fake;
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/setup/synthesizer.ts
git commit -m "test(e2e): fakeButton factory with real message.edit on update"
```

---

## Task 8: `synthesizer.ts` — `fakeModalSubmit` factory

**Files:**
- Modify: `tests/e2e/setup/synthesizer.ts`

- [ ] **Step 1: Append to `tests/e2e/setup/synthesizer.ts`**

```ts
export interface FakeModalSubmitInit {
  client: Client;
  guild: Guild;
  channel: TextBasedChannel;
  member: GuildMember;
  user: User;
  customId: string;
  fields: Record<string, string>;
}

export interface FakeModalSubmit {
  type: 'modalSubmit';
  client: Client;
  guild: Guild;
  channel: TextBasedChannel;
  member: GuildMember;
  user: User;
  customId: string;
  fields: { getTextInputValue(customId: string): string };
  createdTimestamp: number;
  deferred: boolean;
  replied: boolean;

  __replies: FakeReply[];
  __editedReply: FakeReply | null;
  __followUps: FakeReply[];

  reply(opts: InteractionReplyOptions | string): Promise<unknown>;
  deferReply(opts?: { flags?: number }): Promise<unknown>;
  editReply(opts: InteractionEditReplyOptions | string): Promise<unknown>;
  followUp(opts: InteractionReplyOptions | string): Promise<unknown>;
}

export function fakeModalSubmit(init: FakeModalSubmitInit): FakeModalSubmit {
  const fake: FakeModalSubmit = {
    type: 'modalSubmit',
    client: init.client,
    guild: init.guild,
    channel: init.channel,
    member: init.member,
    user: init.user,
    customId: init.customId,
    fields: {
      getTextInputValue(id: string) {
        const v = init.fields[id];
        if (v === undefined) {
          throw new Error(`modal field "${id}" not provided in fakeModalSubmit`);
        }
        return v;
      },
    },
    createdTimestamp: Date.now(),
    deferred: false,
    replied: false,
    __replies: [],
    __editedReply: null,
    __followUps: [],

    async reply(opts) {
      fake.__replies.push({ options: opts, ephemeral: isEphemeral(opts) });
      fake.replied = true;
      return { resource: { message: { createdTimestamp: Date.now() } } };
    },
    async deferReply(opts) {
      fake.deferred = true;
      return undefined;
    },
    async editReply(opts) {
      fake.__editedReply = { options: opts as InteractionReplyOptions, ephemeral: false };
      return { id: 'fake-edited-reply' };
    },
    async followUp(opts) {
      const ephemeral = isEphemeral(opts);
      fake.__followUps.push({ options: opts, ephemeral });
      if (!ephemeral && init.channel.isSendable()) {
        const payload = typeof opts === 'string' ? { content: opts } : opts;
        await init.channel.send(payload as Parameters<typeof init.channel.send>[0]);
      }
      return { id: 'fake-follow-up' };
    },
  };
  return fake;
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/setup/synthesizer.ts
git commit -m "test(e2e): fakeModalSubmit factory"
```

---

## Task 9: `tests/e2e/setup/bootstrap.ts` — boot client + cache scaffold

**Files:**
- Create: `tests/e2e/setup/bootstrap.ts`

- [ ] **Step 1: Create `tests/e2e/setup/bootstrap.ts`**

```ts
import { Client, GatewayIntentBits, Partials, type Guild, type GuildMember } from 'discord.js';
import { loadE2EEnv } from './env.js';

export interface E2EContext {
  client: Client;
  guild: Guild;
  tester: GuildMember;
  voterA: GuildMember;
  voterB: GuildMember;
  officer: GuildMember;
}

let context: E2EContext | null = null;

export async function bootstrapE2E(): Promise<E2EContext> {
  if (context) return context;

  const env = loadE2EEnv();
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });

  await new Promise<void>((resolve, reject) => {
    client.once('ready', () => resolve());
    client.once('error', reject);
    client.login(env.discordToken).catch(reject);
  });

  const guild = await client.guilds.fetch(env.sandboxGuildId);
  await guild.members.fetch();

  const fetchMember = async (id: string, label: string): Promise<GuildMember> => {
    const m = await guild.members.fetch(id).catch(() => null);
    if (!m) throw new Error(`Sandbox member ${label} (${id}) not found in guild ${guild.id}`);
    return m;
  };

  context = {
    client,
    guild,
    tester: await fetchMember(env.testerPrimaryId, 'TESTER_PRIMARY'),
    voterA: await fetchMember(env.voterAId, 'VOTER_A'),
    voterB: await fetchMember(env.voterBId, 'VOTER_B'),
    officer: await fetchMember(env.officerId, 'OFFICER'),
  };
  return context;
}

export async function shutdownE2E(): Promise<void> {
  if (!context) return;
  await context.client.destroy();
  context = null;
}

export function getE2EContext(): E2EContext {
  if (!context) throw new Error('bootstrapE2E() must be called before getE2EContext()');
  return context;
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/setup/bootstrap.ts
git commit -m "test(e2e): bootstrap live client + cache guild/members"
```

---

## Task 10: `tests/e2e/setup/verifyScaffold.ts` — fail-fast scaffold check

**Files:**
- Create: `tests/e2e/setup/verifyScaffold.ts`

- [ ] **Step 1: Create `tests/e2e/setup/verifyScaffold.ts`**

```ts
import { getE2EContext } from './bootstrap.js';

/**
 * Verifies the sandbox guild has the minimum scaffolding required for e2e.
 * Expands as additional tests pull in more scaffolding requirements.
 * Run once in globalSetup; fail loudly so we don't chase mystery errors.
 */
export async function verifyScaffold(): Promise<void> {
  const { guild, tester, voterA, voterB, officer } = getE2EContext();

  const missing: string[] = [];

  // Each tester member must be present in the guild.
  for (const [label, m] of [
    ['TESTER_PRIMARY', tester],
    ['VOTER_A', voterA],
    ['VOTER_B', voterB],
    ['OFFICER', officer],
  ] as const) {
    if (!guild.members.cache.has(m.id)) {
      missing.push(`member:${label}`);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Sandbox guild scaffold missing: ${missing.join(', ')}. ` +
      `See docs/superpowers/runbook/e2e-scaffold-setup.md`,
    );
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add tests/e2e/setup/verifyScaffold.ts
git commit -m "test(e2e): scaffold verification with clear error messages"
```

---

## Task 11: `tests/e2e/setup/assertions.ts` — common helpers

**Files:**
- Create: `tests/e2e/setup/assertions.ts`

- [ ] **Step 1: Create `tests/e2e/setup/assertions.ts`**

```ts
import { openTestDbReadonly } from './db.js';
import type { TextBasedChannel, ThreadChannel, GuildMember, Role, Message } from 'discord.js';

export function queryOne<T = unknown>(sql: string, params: unknown[] = []): T | undefined {
  const db = openTestDbReadonly();
  try {
    return db.prepare(sql).get(...params) as T | undefined;
  } finally {
    db.close();
  }
}

export function queryAll<T = unknown>(sql: string, params: unknown[] = []): T[] {
  const db = openTestDbReadonly();
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

export async function findRecentMessage(
  channel: TextBasedChannel,
  predicate: (m: Message) => boolean,
  limit = 20,
): Promise<Message | null> {
  const msgs = await channel.messages.fetch({ limit });
  for (const m of msgs.values()) {
    if (predicate(m)) return m;
  }
  return null;
}

export async function assertMemberHasRole(member: GuildMember, role: Role): Promise<void> {
  const fresh = await member.guild.members.fetch(member.id);
  if (!fresh.roles.cache.has(role.id)) {
    throw new Error(`member ${fresh.user.tag} missing role ${role.name}`);
  }
}

export async function assertMemberLacksRole(member: GuildMember, role: Role): Promise<void> {
  const fresh = await member.guild.members.fetch(member.id);
  if (fresh.roles.cache.has(role.id)) {
    throw new Error(`member ${fresh.user.tag} unexpectedly has role ${role.name}`);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add tests/e2e/setup/assertions.ts
git commit -m "test(e2e): common DB + Discord assertion helpers"
```

---

## Task 12: `tests/e2e/setup/baseline.ts` — `resetAndSeed`

**Files:**
- Create: `tests/e2e/setup/baseline.ts`

- [ ] **Step 1: Create `tests/e2e/setup/baseline.ts`**

```ts
import { getE2EContext } from './bootstrap.js';
import { fakeChatInput } from './synthesizer.js';
import { wipeTestDb } from './db.js';
import { initDatabase } from '../../../src/database/db.js';
import testdataCmd from '../../../src/commands/testdata.js';
import type { ChatInputCommandInteraction, TextBasedChannel } from 'discord.js';

/**
 * Brings the sandbox guild + test DB to a deterministic baseline.
 * Invoked in beforeEach of every e2e test file.
 *
 * 1. Wipes the test SQLite file.
 * 2. Re-initializes schema (same path the bot uses at startup).
 * 3. Invokes /testdata reset confirm:true as OFFICER.
 * 4. Invokes /testdata seed_all discord:true as OFFICER.
 */
export async function resetAndSeed(): Promise<void> {
  const { client, guild, officer } = getE2EContext();

  wipeTestDb();
  initDatabase();

  const channel = guild.systemChannel ?? guild.channels.cache.find((c) => c.isTextBased())!;

  const reset = fakeChatInput({
    client,
    guild,
    channel: channel as TextBasedChannel,
    member: officer,
    user: officer.user,
    commandName: 'testdata',
    subcommand: 'reset',
    options: { confirm: true },
  });
  await testdataCmd.execute(reset as unknown as ChatInputCommandInteraction);

  const seedAll = fakeChatInput({
    client,
    guild,
    channel: channel as TextBasedChannel,
    member: officer,
    user: officer.user,
    commandName: 'testdata',
    subcommand: 'seed_all',
    options: { discord: true },
  });
  await testdataCmd.execute(seedAll as unknown as ChatInputCommandInteraction);
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/setup/baseline.ts
git commit -m "test(e2e): resetAndSeed baseline via /testdata"
```

---

## Task 13: `tests/e2e/setup/globalSetup.ts` — vitest lifecycle

**Files:**
- Create: `tests/e2e/setup/globalSetup.ts`

- [ ] **Step 1: Create `tests/e2e/setup/globalSetup.ts`**

```ts
import { bootstrapE2E, shutdownE2E } from './bootstrap.js';
import { verifyScaffold } from './verifyScaffold.js';

export async function setup(): Promise<void> {
  await bootstrapE2E();
  await verifyScaffold();
}

export async function teardown(): Promise<void> {
  await shutdownE2E();
}
```

- [ ] **Step 2: Commit**

```bash
git add tests/e2e/setup/globalSetup.ts
git commit -m "test(e2e): wire bootstrap + scaffold check into globalSetup"
```

---

## Task 14: Runbook — sandbox guild provisioning

**Files:**
- Create: `docs/superpowers/runbook/e2e-scaffold-setup.md`

- [ ] **Step 1: Create the runbook**

```markdown
# Sandbox guild scaffold setup (e2e tests)

One-time manual provisioning for the Discord server that backs `npm run test:e2e`.

## 1. Create a dedicated guild

- Create a new Discord server. Do NOT use the production guild.
- Community features: enable (forum channels require it).
- Record the guild ID; put it in `.env.test` as `SANDBOX_GUILD_ID`.

## 2. Create a bot application

- Discord Developer Portal → New Application → Bot → reset token.
- Put token in `.env.test` as `DISCORD_TOKEN_TEST`.
- OAuth2 URL generator → scopes: `bot`, `applications.commands`; permissions: Administrator (fine for a sandbox).
- Invite the bot to the sandbox guild.
- Run `npm run deploy-commands` with `GUILD_ID` pointing at the sandbox guild to register commands.

## 3. Create tester members

Invite four real user accounts to the sandbox guild (burner accounts are fine). Note each user ID and populate:

- `TESTER_PRIMARY_ID`
- `VOTER_A_ID`
- `VOTER_B_ID`
- `OFFICER_ID`

Give `OFFICER_ID` the officer role that `requireOfficer` checks for in `src/commands/utils.ts`.

## 4. Provision channels and roles

Run the bot locally against the sandbox guild, then use `/setup` to create the expected channel structure. Record the resulting channel IDs in `.env.test` — names and required IDs expand as e2e tests grow; keep this section in sync.

## 5. External API credentials

- `RAIDERIO_API_KEY` — raider.io API key.
- `WOWAUDIT_API_KEY` — wowaudit API key.

## 6. Verify

```bash
npm run test:e2e -- tests/e2e/commands/ping.e2e.ts
```

If `verifyScaffold()` reports missing pieces, add them.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/runbook/e2e-scaffold-setup.md
git commit -m "docs: e2e sandbox guild provisioning runbook"
```

---

## Task 15: Smoke test — `/ping` e2e

**Files:**
- Create: `tests/e2e/commands/ping.e2e.ts`

This is the **first end-to-end test**. Running it validates the entire stack: env loading, bootstrap, scaffold verify, synthesizer, handler invocation. Expect iteration here — any synthesizer method gap surfaces now.

- [ ] **Step 1: Create `tests/e2e/commands/ping.e2e.ts`**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import type { ChatInputCommandInteraction, TextBasedChannel } from 'discord.js';
import { getE2EContext } from '../setup/bootstrap.js';
import { fakeChatInput } from '../setup/synthesizer.js';
import { resetAndSeed } from '../setup/baseline.js';
import pingCmd from '../../../src/commands/ping.js';

describe('/ping', () => {
  beforeEach(async () => {
    await resetAndSeed();
  });

  it('replies with latency information', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;
    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.tester,
      user: ctx.tester.user,
      commandName: 'ping',
    });

    await pingCmd.execute(iact as unknown as ChatInputCommandInteraction);

    expect(iact.__replies.length).toBe(1);
    expect(iact.__editedReply).not.toBeNull();
    const reply = iact.__editedReply!.options;
    const text = typeof reply === 'string' ? reply : (reply as { content?: string }).content ?? '';
    expect(text).toMatch(/Pong!/);
    expect(text).toMatch(/API Latency/);
  });
});
```

- [ ] **Step 2: Run the test (assumes `.env.test` is populated and sandbox scaffold is provisioned)**

Run: `npm run test:e2e -- tests/e2e/commands/ping.e2e.ts`
Expected: PASS. If it fails with a synthesizer error, extend the synthesizer and re-run.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/commands/ping.e2e.ts
git commit -m "test(e2e): /ping smoke test"
```

---

## Command test template

For each command test file below, follow this shape:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import type { ChatInputCommandInteraction, TextBasedChannel } from 'discord.js';
import { getE2EContext } from '../setup/bootstrap.js';
import { fakeChatInput } from '../setup/synthesizer.js';
import { resetAndSeed } from '../setup/baseline.js';
import { queryOne, queryAll } from '../setup/assertions.js';
import <cmd> from '../../../src/commands/<cmd>.js';

describe('/<cmd>', () => {
  beforeEach(async () => {
    await resetAndSeed();
  });

  it('<behavior>', async () => {
    const ctx = getE2EContext();
    const channel = ctx.guild.systemChannel as TextBasedChannel;
    const iact = fakeChatInput({
      client: ctx.client,
      guild: ctx.guild,
      channel,
      member: ctx.tester,
      user: ctx.tester.user,
      commandName: '<cmd>',
      subcommand: '<sub>',
      options: { /* ... */ },
    });

    await cmd.execute(iact as unknown as ChatInputCommandInteraction);

    // Assertions: DB first, then interaction recordings, then guild reads.
  });
});
```

Every command test task below lists the exact subcommands/options it must cover. If a handler calls a method the synthesizer does not yet implement, extend the synthesizer (add the method, commit that change first with a dedicated commit), then continue.

---

## Task 16: `/help` e2e

**Files:**
- Create: `tests/e2e/commands/help.e2e.ts`

- [ ] **Step 1: Inspect the handler**

Read `src/commands/help.ts` to determine its reply shape (likely an embed listing commands).

- [ ] **Step 2: Write the test**

Following the template, invoke as `ctx.tester`, assert `iact.__replies.length === 1`, assert the reply's embed (or content) includes at least three known command names (e.g., `ping`, `trials`, `applications`).

- [ ] **Step 3: Run, fix, commit**

Run: `npm run test:e2e -- tests/e2e/commands/help.e2e.ts`
Expected: PASS. Commit as `test(e2e): /help`.

---

## Task 17: `/loglevel` e2e

**Files:**
- Create: `tests/e2e/commands/loglevel.e2e.ts`

- [ ] **Step 1: Inspect the handler**

Read `src/commands/loglevel.ts`. Note any permission gating; if officer-required, invoke as `ctx.officer`.

- [ ] **Step 2: Write the test**

Cover setting and reading the log level. Assert side-effect on the logger (call `logger.getLevel()` or similar — read the source to see what the command exposes for inspection). If only visible via a reply, assert on `__replies` content.

- [ ] **Step 3: Run, fix, commit**

---

## Task 18: `/guildinfo` e2e

**Files:**
- Create: `tests/e2e/commands/guildinfo.e2e.ts`

- [ ] **Step 1: Inspect the handler**

Read `src/commands/guildinfo.ts`.

- [ ] **Step 2: Write the test**

Invoke as `ctx.tester`. Assert reply contains the sandbox guild's name or ID.

- [ ] **Step 3: Run, fix, commit**

---

## Task 19: `/settings` e2e

**Files:**
- Create: `tests/e2e/commands/settings.e2e.ts`

- [ ] **Step 1: Inspect the handler + subcommands**

Read `src/commands/settings.ts`. Enumerate subcommands.

- [ ] **Step 2: Write one `it(...)` per subcommand**

Cover both the getter and setter paths. Use DB queries from `queryOne` to verify persistence for setter subcommands.

- [ ] **Step 3: Run, fix, commit**

---

## Task 20: `/setup` e2e

**Files:**
- Create: `tests/e2e/commands/setup.e2e.ts`

- [ ] **Step 1: Inspect the handler**

Read `src/commands/setup.ts`. Note: `/setup` typically creates channel structure. Because the sandbox guild's channel structure is pre-provisioned, testing `/setup` here should verify **idempotent** behavior (running it against an already-set-up guild does not duplicate channels) rather than creation from scratch.

- [ ] **Step 2: Write the test**

Capture the guild's channel IDs before invocation, run `/setup`, capture after — assert the set is unchanged (or that the command emits a "setup already complete" style reply).

- [ ] **Step 3: Run, fix, commit**

---

## Task 21: `/status` e2e

**Files:**
- Create: `tests/e2e/commands/status.e2e.ts`

- [ ] **Step 1: Read the handler**

Read `src/commands/status.ts`.

- [ ] **Step 2: Test each subcommand/path**

For each subcommand, assert the reply content/embed reflects the DB state seeded by `seed_all`.

- [ ] **Step 3: Run, fix, commit**

---

## Task 22: `/updateachievements` e2e

**Files:**
- Create: `tests/e2e/commands/updateachievements.e2e.ts`

**Requires:** real raider.io calls.

- [ ] **Step 1: Read the handler**

Read `src/commands/updateachievements.ts` — note which raider.io endpoints it hits.

- [ ] **Step 2: Write the test**

Invoke as officer. Seeded raiders in `seed_all` should be real WoW characters so raider.io returns data (if seeds use synthetic names, the first run reveals this; switch seeds to real known names in that case — document the decision in a follow-up commit). Assert achievement rows are written to DB.

- [ ] **Step 3: Run, fix, commit**

Header comment: `// requires: raider.io`.

---

## Task 23: `/raiders` e2e

**Files:**
- Create: `tests/e2e/commands/raiders.e2e.ts`

- [ ] **Step 1: Read the handler + subcommands**

Read `src/commands/raiders.ts`. Note pagination in `get_raiders`.

- [ ] **Step 2: Write subcommand tests**

For `get_raiders`, assert the first page replies correctly. For pagination click-through: use `fakeButton` on the real paginated message (fetch it from the channel after the initial reply). If the pagination handler uses `interaction.update`, the synthesizer's `update()` call will edit the real message; re-fetch to assert updated content.

- [ ] **Step 3: Run, fix, commit**

---

## Task 24: `/trials` e2e

**Files:**
- Create: `tests/e2e/commands/trials.e2e.ts`

- [ ] **Step 1: Read the handler**

Read `src/commands/trials.ts`. Enumerate subcommands.

- [ ] **Step 2: Write one test per subcommand**

Cover add, list, promote, remove paths with DB assertions.

- [ ] **Step 3: Run, fix, commit**

---

## Task 25: `/applications` e2e

**Files:**
- Create: `tests/e2e/commands/applications.e2e.ts`

- [ ] **Step 1: Read the handler**

Read `src/commands/applications.ts`. Covers listing/filtering applications.

- [ ] **Step 2: Write tests**

With `seed_application_variety` running as part of `seed_all`, applications of each status should exist. Assert list output for each filter.

- [ ] **Step 3: Run, fix, commit**

---

## Task 26: `/apply` e2e (command invocation only)

**Files:**
- Create: `tests/e2e/commands/apply.e2e.ts`

- [ ] **Step 1: Read the handler**

Read `src/commands/apply.ts`. If `/apply` opens a modal or DMs the user, assert `iact.__modalShown` is non-null OR that a DM channel was opened to `ctx.tester`. Full DM flow is covered in the flow file in Task 31.

- [ ] **Step 2: Write the test for the command-invocation surface only**

- [ ] **Step 3: Run, fix, commit**

---

## Task 27: `/epgp` e2e

**Files:**
- Create: `tests/e2e/commands/epgp.e2e.ts`

**Requires:** real wowaudit calls for upload-path subcommands.

- [ ] **Step 1: Read the handler**

Read `src/commands/epgp.ts`. Enumerate subcommands (`upload`, point queries, display, etc.).

- [ ] **Step 2: Write one test per subcommand**

For `upload`, pass a test CSV (either a file attachment shim or a known-fixture path — read how the handler consumes the attachment and mock the `getAttachment` return value with a URL the handler can fetch from a local fixture server, OR — simpler — refactor the handler to accept an alternate input path for tests). If refactor is required, make it minimal and flag in a follow-up discussion.

Header comment: `// requires: wowaudit`.

- [ ] **Step 3: Run, fix, commit**

---

## Task 28: `/loot` e2e

**Files:**
- Create: `tests/e2e/commands/loot.e2e.ts`

- [ ] **Step 1: Read the handler**

Read `src/commands/loot.ts`.

- [ ] **Step 2: Write one test per subcommand**

Cover posting, listing, awarding (awarding is a multi-step flow — defer full interactive path to Task 32).

- [ ] **Step 3: Run, fix, commit**

---

## Task 29: `/testdata` e2e (meta-test)

**Files:**
- Create: `tests/e2e/commands/testdata.e2e.ts`

Tests `/testdata` subcommands individually (not just via baseline). Provides regression coverage of the seeds themselves.

- [ ] **Step 1: Write tests for each subcommand**

For each of `seed_raiders`, `seed_application`, `seed_application_variety`, `seed_trial`, `seed_epgp`, `seed_loot`, `seed_all`, `reset`: call `resetAndSeed()` then invoke the subcommand (except `seed_all`, which is already in baseline — test it in isolation by calling `reset` then `seed_all` directly), assert DB rows and Discord artifacts.

- [ ] **Step 2: Run, fix, commit**

---

## Task 30: Applications voting flow

**Files:**
- Create: `tests/e2e/flows/applications-vote.e2e.ts`

- [ ] **Step 1: Inspect the voting button handler**

Find the component handler (likely in `src/events/interactionCreate.ts` or a dedicated button handler file). Record the custom ID format (`apply_vote_yes:<appId>`, etc.).

- [ ] **Step 2: Write the flow test**

```
1. resetAndSeed() — seed_application_variety posts a real application forum thread.
2. Fetch the seeded application's forum thread's starter message.
3. fakeButton({ user: voterA, message, customId: yes-vote customId for that app }) → call component handler.
4. fakeButton({ user: voterB, message, customId: yes-vote customId for that app }) → call component handler.
5. Assert DB votes table has two "yes" rows for that app + voter IDs.
6. Assert the application's state transitioned per the configured vote threshold (read the seeded app's status in DB).
```

- [ ] **Step 3: Run, fix, commit**

---

## Task 31: Apply modal / DM flow

**Files:**
- Create: `tests/e2e/flows/apply-modal.e2e.ts`

- [ ] **Step 1: Inspect the apply flow**

Read `src/commands/apply.ts` and any collectors it creates. Determine whether the flow is modal-only or modal + DM question/answer sequence.

- [ ] **Step 2: Write the flow test**

Simulate: `/apply` → collect the modal that was shown → `fakeModalSubmit` with answers → assert a forum thread was created with the applicant's data and that a row exists in the applications table.

If the handler uses DM back-and-forth (per spec mention of "DM resume"), the flow is more involved: walk the test through each DM prompt using `fakeChatInput` against a `DMChannel`. Extend the synthesizer if needed.

- [ ] **Step 3: Run, fix, commit**

---

## Task 32: Loot award flow

**Files:**
- Create: `tests/e2e/flows/loot-award.e2e.ts`

- [ ] **Step 1: Inspect**

Read the loot post/button flow. Note the claim button's customId format and the award/confirm flow.

- [ ] **Step 2: Write the flow test**

Seeded loot posts exist after `seed_all`. Claim one as a tester → assert DB `loot_awards` row + EPGP delta (GP charged) + message update reflecting the awarded-to user.

- [ ] **Step 3: Run, fix, commit**

---

## Task 33: Trial alerts scheduled job

**Files:**
- Create: `tests/e2e/flows/trial-alerts.e2e.ts`

- [ ] **Step 1: Locate the alert handler**

Find the function registered with `scheduler.registerCron` or `registerInterval` for trial alerts. Import it directly (bypass the scheduler wrapper).

- [ ] **Step 2: Write the test**

With seeded trials having alerts scheduled in the near past, directly invoke the handler. Assert the configured trial-review channel received the expected alert message.

- [ ] **Step 3: Run, fix, commit**

---

## Task 34: EPGP decay scheduled job

**Files:**
- Create: `tests/e2e/flows/epgp-decay.e2e.ts`

- [ ] **Step 1: Locate the decay handler**

- [ ] **Step 2: Write the test**

Capture EP/GP values pre-invocation, invoke the handler directly, assert decayed values per the decay formula.

- [ ] **Step 3: Run, fix, commit**

---

## Task 35: Backup scheduled job

**Files:**
- Create: `tests/e2e/flows/backup.e2e.ts`

- [ ] **Step 1: Locate the backup handler**

- [ ] **Step 2: Write the test**

Invoke directly. Assert a backup file was written under the configured backup dir (redirect to a test-owned temp dir for isolation if the handler supports config; otherwise accept the side-effect in the default dir and clean up in `afterEach`).

- [ ] **Step 3: Run, fix, commit**

---

## Task 36: Thread keep-alive scheduled job

**Files:**
- Create: `tests/e2e/flows/thread-keep-alive.e2e.ts`

- [ ] **Step 1: Locate the keep-alive handler**

- [ ] **Step 2: Write the test**

Seed a forum thread via `seed_trial discord:true`, age it artificially (DB update to set archive threshold near), invoke the handler, assert the thread's archive timestamp was refreshed (fetch via Discord API).

- [ ] **Step 3: Run, fix, commit**

---

## Task 37: DM resume flow

**Files:**
- Create: `tests/e2e/flows/dm-resume.e2e.ts`

- [ ] **Step 1: Inspect the DM resume logic**

Locate where incomplete DM applications are tracked in the DB and how the resume path is triggered.

- [ ] **Step 2: Write the test**

Start an `/apply` flow, simulate an interruption after N answers (persist partial state), trigger the resume event (new DM from the same user or bot startup handler), assert the flow resumes at the correct next question.

- [ ] **Step 3: Run, fix, commit**

---

## Final verification

- [ ] **Run the full suite**

Run: `npm run test:e2e`
Expected: all e2e tests pass.

- [ ] **Run the default suite to confirm no regressions**

Run: `npm test`
Expected: all unit + integration tests pass.

- [ ] **Confirm the `e2e` project is excluded from the default run**

`npm test` should not attempt to login to Discord.

---

## Notes for the executing engineer

- **Expect synthesizer gaps.** The first time a handler calls a method the synthesizer doesn't implement, you will see a clear "not implemented" error. Add the method with a matching `__` recording property, commit as `test(e2e): synthesizer — add <method>`, then continue.
- **Channel cache.** The sandbox guild fetches members once in `bootstrapE2E`. If a test modifies a member's roles, re-fetch via `guild.members.fetch(id)` before asserting — don't trust the cache.
- **Rate limits.** If full runs start hitting 429s, add a small (250ms) inter-test delay in `beforeEach` after `resetAndSeed()`. Don't paper over individual 429s — they indicate a real pacing problem.
- **Keep seeds stable.** When extending `seed_all`, update tests accordingly. Seeds are the contract between `resetAndSeed` and every test.
- **Commits stay small.** Most tasks above end in a commit. Don't batch unrelated changes.

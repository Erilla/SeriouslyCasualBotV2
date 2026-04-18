# Channel Auto-Creation & Category Mapping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every auto-created channel goes through a single helper that resolves by stored config ID → guild-wide name lookup → create under a configured parent category. Wire up `bot-logs`/`bot-audit` to the logger/audit services, fix the EPGP config-key mismatch, and migrate every existing `getOrCreate*` call site.

**Architecture:** A new module `src/functions/channels.ts` exports `getCategoryByName` and `getOrCreateChannel`. Each of ~8 call sites is refactored from bespoke inline lookup/create blocks to a single call to the helper. `ready.ts` gains a startup block that pre-resolves `bot-logs`/`bot-audit`/`epgp-rankings` and hands the first two to `logger.setDiscordChannel()` and `setAuditChannel()`. A one-shot idempotent DB migration renames the EPGP config key.

**Tech Stack:** TypeScript 6 + ESM + discord.js v14 + better-sqlite3 + vitest

**Execution environment:** This plan is intended to run in the git worktree at `.worktrees/channel-auto-creation` on branch `feat/channel-auto-creation` (already created). The spec lives at `docs/superpowers/specs/2026-04-18-channel-auto-creation-design.md`.

---

### Task 1: `channels.ts` helper — `getCategoryByName` (TDD)

**Files:**
- Create: `src/functions/channels.ts`
- Create: `tests/unit/channels.test.ts`

- [ ] **Step 1: Create the test file with the first failing test**

```typescript
// tests/unit/channels.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { ChannelType } from 'discord.js';
import type { Guild, CategoryChannel, GuildBasedChannel } from 'discord.js';
import { createTables } from '../../src/database/schema.js';
import { getDatabase, closeDatabase } from '../../src/database/db.js';
import { getCategoryByName } from '../../src/functions/channels.js';

type MockChannel = {
  id: string;
  name: string;
  type: ChannelType;
  parentId: string | null;
};

function mkChannel(partial: Partial<MockChannel> & { id: string; name: string; type: ChannelType }): MockChannel {
  return { parentId: null, ...partial };
}

function mkGuild(channels: MockChannel[] = []): Guild {
  const map = new Map<string, MockChannel>(channels.map((c) => [c.id, c]));
  const cache = {
    get: (id: string) => map.get(id),
    find: (predicate: (c: MockChannel) => boolean) => {
      for (const c of map.values()) if (predicate(c)) return c;
      return undefined;
    },
    filter: (predicate: (c: MockChannel) => boolean) => {
      const out: MockChannel[] = [];
      for (const c of map.values()) if (predicate(c)) out.push(c);
      return out;
    },
    values: () => map.values(),
  };
  return {
    id: 'guild-1',
    channels: {
      cache,
      fetch: vi.fn(async (id: string) => map.get(id) ?? null),
      create: vi.fn(async (opts: { name: string; type: ChannelType; parent?: string | null }) => {
        const created: MockChannel = {
          id: `created-${opts.name}`,
          name: opts.name,
          type: opts.type,
          parentId: opts.parent ?? null,
        };
        map.set(created.id, created);
        return created;
      }),
    },
  } as unknown as Guild;
}

beforeEach(() => {
  closeDatabase();
  const db = getDatabase(':memory:');
  createTables(db);
});

afterEach(() => {
  closeDatabase();
});

describe('getCategoryByName', () => {
  it('finds a category by exact name', () => {
    const guild = mkGuild([
      mkChannel({ id: 'cat-1', name: 'Overlords', type: ChannelType.GuildCategory }),
      mkChannel({ id: 'cat-2', name: 'Raiders', type: ChannelType.GuildCategory }),
    ]);

    const found = getCategoryByName(guild, 'Overlords');

    expect(found?.id).toBe('cat-1');
  });

  it('returns null when no category with that name exists', () => {
    const guild = mkGuild([
      mkChannel({ id: 'cat-1', name: 'Overlords', type: ChannelType.GuildCategory }),
    ]);

    const found = getCategoryByName(guild, 'DoesNotExist');

    expect(found).toBeNull();
  });

  it('matches case-insensitively', () => {
    const guild = mkGuild([
      mkChannel({ id: 'cat-1', name: 'Overlords', type: ChannelType.GuildCategory }),
    ]);

    const found = getCategoryByName(guild, 'overlords');

    expect(found?.id).toBe('cat-1');
  });

  it('ignores non-category channels with the same name', () => {
    const guild = mkGuild([
      mkChannel({ id: 'ch-1', name: 'Overlords', type: ChannelType.GuildText }),
    ]);

    const found = getCategoryByName(guild, 'Overlords');

    expect(found).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/channels.test.ts`
Expected: FAIL — cannot resolve `src/functions/channels.js`.

- [ ] **Step 3: Create the helper module with `getCategoryByName`**

```typescript
// src/functions/channels.ts
import { ChannelType, type Guild, type CategoryChannel } from 'discord.js';

export function getCategoryByName(guild: Guild, name: string): CategoryChannel | null {
  const target = name.toLowerCase();
  const match = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === target,
  );
  return (match as CategoryChannel | undefined) ?? null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/channels.test.ts`
Expected: PASS (4 tests in the `getCategoryByName` describe block).

- [ ] **Step 5: Commit**

```bash
git add src/functions/channels.ts tests/unit/channels.test.ts
git commit -m "feat(channels): add getCategoryByName helper

Case-insensitive name lookup for category channels. First piece of the
unified channel-resolution helper."
```

---

### Task 2: `getOrCreateChannel` — config-ID hit path (TDD)

**Files:**
- Modify: `src/functions/channels.ts`
- Modify: `tests/unit/channels.test.ts`

- [ ] **Step 1: Add failing tests for the config-ID path**

Append to `tests/unit/channels.test.ts`:

```typescript
import { getOrCreateChannel } from '../../src/functions/channels.js';

function setConfig(key: string, value: string): void {
  getDatabase().prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, value);
}

function getConfig(key: string): string | undefined {
  const row = getDatabase().prepare('SELECT value FROM config WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

describe('getOrCreateChannel — config-ID path', () => {
  it('returns the channel referenced by the stored config ID when it exists with correct type', async () => {
    const guild = mkGuild([
      mkChannel({ id: 'ch-existing', name: 'trial-reviews', type: ChannelType.GuildForum }),
    ]);
    setConfig('trial_reviews_forum_id', 'ch-existing');

    const result = await getOrCreateChannel(guild, {
      name: 'trial-reviews',
      type: ChannelType.GuildForum,
      categoryName: 'Overlords',
      configKey: 'trial_reviews_forum_id',
    });

    expect(result.id).toBe('ch-existing');
    expect(guild.channels.create).not.toHaveBeenCalled();
  });

  it('ignores the stored ID when the channel has been deleted and falls through', async () => {
    const guild = mkGuild([]);
    setConfig('trial_reviews_forum_id', 'ch-gone');

    const result = await getOrCreateChannel(guild, {
      name: 'trial-reviews',
      type: ChannelType.GuildForum,
      categoryName: 'Overlords',
      configKey: 'trial_reviews_forum_id',
    });

    // Will create — no name match, no category, so parent-less create
    expect(result.name).toBe('trial-reviews');
    expect(guild.channels.create).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/channels.test.ts`
Expected: FAIL — `getOrCreateChannel` is not exported.

- [ ] **Step 3: Implement the helper with config-ID, name-lookup, and create paths**

Replace the contents of `src/functions/channels.ts`:

```typescript
import {
  ChannelType,
  type Guild,
  type CategoryChannel,
  type GuildBasedChannel,
  type GuildChannelCreateOptions,
} from 'discord.js';
import { getDatabase } from '../database/db.js';
import { logger } from '../services/logger.js';

export function getCategoryByName(guild: Guild, name: string): CategoryChannel | null {
  const target = name.toLowerCase();
  const match = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === target,
  );
  return (match as CategoryChannel | undefined) ?? null;
}

export interface GetOrCreateChannelOptions {
  name: string;
  type: ChannelType.GuildText | ChannelType.GuildForum | ChannelType.GuildCategory;
  categoryName: string | null;
  configKey: string;
  aliasNames?: string[];
  createOptions?: Partial<GuildChannelCreateOptions>;
}

const warnedMissingCategories = new Set<string>();

function readConfig(key: string): string | undefined {
  const row = getDatabase().prepare('SELECT value FROM config WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

function writeConfig(key: string, value: string): void {
  getDatabase()
    .prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)')
    .run(key, value);
}

function deleteConfig(key: string): void {
  getDatabase().prepare('DELETE FROM config WHERE key = ?').run(key);
}

export async function getOrCreateChannel(
  guild: Guild,
  opts: GetOrCreateChannelOptions,
): Promise<GuildBasedChannel> {
  // 1. Stored config ID
  const storedId = readConfig(opts.configKey);
  if (storedId) {
    const cached =
      guild.channels.cache.get(storedId) ??
      (await guild.channels.fetch(storedId).catch(() => null));
    if (cached && cached.type === opts.type) {
      return cached as GuildBasedChannel;
    }
    // Stale — clear and fall through
    deleteConfig(opts.configKey);
  }

  // 2. Name lookup (case-insensitive; checks opts.name and any aliasNames).
  // Materialize the cache as an array first — Collection.filter returns a
  // Collection (no .length, no [0], no array semantics), so we can't chain
  // array ops on it. Match by name regardless of channel type, then split
  // by type so we can warn on wrong-type conflicts AND still reuse a
  // correctly-typed match (including when opts.type is GuildCategory, e.g.
  // for Applications).
  const targets = [opts.name, ...(opts.aliasNames ?? [])].map((n) => n.toLowerCase());
  const allChannels = [...guild.channels.cache.values()] as unknown as GuildBasedChannel[];
  const nameMatches = allChannels.filter((c) => targets.includes(c.name.toLowerCase()));
  const correctlyTypedMatches = nameMatches.filter((c) => c.type === opts.type);
  const wrongTypedMatches = nameMatches.filter((c) => c.type !== opts.type);

  if (wrongTypedMatches.length > 0) {
    const ids = wrongTypedMatches.map((c) => c.id).join(', ');
    logger.warn(
      'channels',
      `Found "${opts.name}" with wrong channel type (expected ${opts.type}); existing channel(s): ${ids}. Will create a correctly-typed channel.`,
    );
  }

  if (correctlyTypedMatches.length > 0) {
    if (correctlyTypedMatches.length > 1) {
      const ids = correctlyTypedMatches.map((c) => c.id).join(', ');
      logger.warn(
        'channels',
        `Multiple channels named "${opts.name}" found: ${ids}. Using the first.`,
      );
    }
    const resolved = correctlyTypedMatches[0];
    writeConfig(opts.configKey, resolved.id);
    logger.info(
      'channels',
      `Reusing existing channel "${opts.name}" (${resolved.id}) for ${opts.configKey}`,
    );
    return resolved;
  }

  // 3. Parent category
  let parentId: string | undefined;
  if (opts.categoryName) {
    const cat = getCategoryByName(guild, opts.categoryName);
    if (cat) {
      parentId = cat.id;
    } else if (!warnedMissingCategories.has(opts.categoryName)) {
      warnedMissingCategories.add(opts.categoryName);
      logger.warn(
        'channels',
        `Category "${opts.categoryName}" not found; "${opts.name}" will be created without a parent.`,
      );
    }
  }

  // 4. Create
  const created = (await guild.channels.create({
    name: opts.name,
    type: opts.type,
    parent: parentId,
    ...opts.createOptions,
  })) as GuildBasedChannel;

  writeConfig(opts.configKey, created.id);
  logger.info('channels', `Created channel "${opts.name}" (${created.id}) for ${opts.configKey}`);
  return created;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/channels.test.ts`
Expected: PASS (6 tests total — 4 from Task 1 + 2 new).

- [ ] **Step 5: Commit**

```bash
git add src/functions/channels.ts tests/unit/channels.test.ts
git commit -m "feat(channels): add getOrCreateChannel with full resolution flow

Implements stored-config-ID lookup, case-insensitive name lookup (with
aliases and wrong-type warning), parent category resolution (warn on
missing, dedup per process), and the create fallback."
```

---

### Task 3: `getOrCreateChannel` — remaining test coverage (TDD)

**Files:**
- Modify: `tests/unit/channels.test.ts`

- [ ] **Step 1: Add the rest of the failing tests**

Append to `tests/unit/channels.test.ts`:

```typescript
describe('getOrCreateChannel — name lookup', () => {
  it('reuses an existing channel found by name when config is empty', async () => {
    const guild = mkGuild([
      mkChannel({ id: 'cat-1', name: 'Overlords', type: ChannelType.GuildCategory }),
      mkChannel({ id: 'ch-by-name', name: 'trial-reviews', type: ChannelType.GuildForum, parentId: 'cat-1' }),
    ]);

    const result = await getOrCreateChannel(guild, {
      name: 'trial-reviews',
      type: ChannelType.GuildForum,
      categoryName: 'Overlords',
      configKey: 'trial_reviews_forum_id',
    });

    expect(result.id).toBe('ch-by-name');
    expect(guild.channels.create).not.toHaveBeenCalled();
    expect(getConfig('trial_reviews_forum_id')).toBe('ch-by-name');
  });

  it('is case-insensitive on the channel name', async () => {
    const guild = mkGuild([
      mkChannel({ id: 'ch-1', name: 'Trial-Reviews', type: ChannelType.GuildForum }),
    ]);

    const result = await getOrCreateChannel(guild, {
      name: 'trial-reviews',
      type: ChannelType.GuildForum,
      categoryName: null,
      configKey: 'trial_reviews_forum_id',
    });

    expect(result.id).toBe('ch-1');
  });

  it('accepts alias names for the name lookup', async () => {
    const guild = mkGuild([
      mkChannel({ id: 'ch-welcome', name: 'welcome', type: ChannelType.GuildText }),
    ]);

    const result = await getOrCreateChannel(guild, {
      name: 'guild-info',
      type: ChannelType.GuildText,
      categoryName: null,
      configKey: 'guild_info_channel_id',
      aliasNames: ['welcome'],
    });

    expect(result.id).toBe('ch-welcome');
  });

  it('warns and picks the first when duplicates exist', async () => {
    const guild = mkGuild([
      mkChannel({ id: 'ch-1', name: 'raiders-lounge', type: ChannelType.GuildText }),
      mkChannel({ id: 'ch-2', name: 'raiders-lounge', type: ChannelType.GuildText }),
    ]);

    const result = await getOrCreateChannel(guild, {
      name: 'raiders-lounge',
      type: ChannelType.GuildText,
      categoryName: null,
      configKey: 'raiders_lounge_channel_id',
    });

    expect(result.id).toBe('ch-1');
  });

  it('treats a wrong-typed name match as a miss and creates a new channel', async () => {
    const guild = mkGuild([
      mkChannel({ id: 'ch-wrong', name: 'trial-reviews', type: ChannelType.GuildText }),
    ]);

    const result = await getOrCreateChannel(guild, {
      name: 'trial-reviews',
      type: ChannelType.GuildForum,
      categoryName: null,
      configKey: 'trial_reviews_forum_id',
    });

    expect(result.id).not.toBe('ch-wrong');
    expect(result.type).toBe(ChannelType.GuildForum);
    expect(guild.channels.create).toHaveBeenCalledTimes(1);
  });

  it('reuses an existing category by name when resolving a category-type channel', async () => {
    const guild = mkGuild([
      mkChannel({ id: 'cat-apps', name: 'Applications', type: ChannelType.GuildCategory }),
    ]);

    const result = await getOrCreateChannel(guild, {
      name: 'Applications',
      type: ChannelType.GuildCategory,
      categoryName: null,
      configKey: 'applications_category_id',
    });

    expect(result.id).toBe('cat-apps');
    expect(guild.channels.create).not.toHaveBeenCalled();
    expect(getConfig('applications_category_id')).toBe('cat-apps');
  });
});

describe('getOrCreateChannel — create path', () => {
  it('creates under the resolved category when one is named', async () => {
    const guild = mkGuild([
      mkChannel({ id: 'cat-overlords', name: 'Overlords', type: ChannelType.GuildCategory }),
    ]);

    const result = await getOrCreateChannel(guild, {
      name: 'trial-reviews',
      type: ChannelType.GuildForum,
      categoryName: 'Overlords',
      configKey: 'trial_reviews_forum_id',
    });

    expect(guild.channels.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'trial-reviews', parent: 'cat-overlords' }),
    );
    expect(result.parentId).toBe('cat-overlords');
  });

  it('creates without a parent when the category is missing', async () => {
    const guild = mkGuild([]);

    const result = await getOrCreateChannel(guild, {
      name: 'trial-reviews',
      type: ChannelType.GuildForum,
      categoryName: 'Overlords',
      configKey: 'trial_reviews_forum_id',
    });

    expect(guild.channels.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'trial-reviews', parent: undefined }),
    );
    expect(result.parentId).toBeNull();
  });

  it('creates without a parent when categoryName is null', async () => {
    const guild = mkGuild([
      mkChannel({ id: 'cat-overlords', name: 'Overlords', type: ChannelType.GuildCategory }),
    ]);

    await getOrCreateChannel(guild, {
      name: 'Applications',
      type: ChannelType.GuildCategory,
      categoryName: null,
      configKey: 'applications_category_id',
    });

    expect(guild.channels.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Applications', parent: undefined }),
    );
  });

  it('stores the new ID in config', async () => {
    const guild = mkGuild([]);

    await getOrCreateChannel(guild, {
      name: 'loot',
      type: ChannelType.GuildText,
      categoryName: null,
      configKey: 'loot_channel_id',
    });

    expect(getConfig('loot_channel_id')).toBe('created-loot');
  });

  it('passes through createOptions', async () => {
    const guild = mkGuild([]);

    await getOrCreateChannel(guild, {
      name: 'raiders-lounge',
      type: ChannelType.GuildText,
      categoryName: null,
      configKey: 'raiders_lounge_channel_id',
      createOptions: { topic: 'Raider signup alerts and discussion' },
    });

    expect(guild.channels.create).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'Raider signup alerts and discussion' }),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they all pass**

Run: `npx vitest run tests/unit/channels.test.ts`
Expected: PASS (17 tests total). If any test fails it is because of a bug in the implementation from Task 2, not the tests — fix the implementation.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/channels.test.ts
git commit -m "test(channels): add coverage for name lookup and create path"
```

---

### Task 4: EPGP config-key DB migration

**Files:**
- Modify: `src/database/db.ts`
- Modify: `src/functions/epgp/createDisplayPost.ts`
- Test: `tests/unit/db-migration.test.ts` (create)

- [ ] **Step 1: Write a failing test for the migration**

Create `tests/unit/db-migration.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDatabase, closeDatabase, runMigrations } from '../../src/database/db.js';
import { createTables } from '../../src/database/schema.js';

beforeEach(() => {
  closeDatabase();
  const db = getDatabase(':memory:');
  createTables(db);
});

afterEach(() => {
  closeDatabase();
});

describe('runMigrations — epgp_channel_id -> epgp_rankings_channel_id', () => {
  it('moves the old key value to the new key', () => {
    const db = getDatabase();
    db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run('epgp_channel_id', 'chan-123');

    runMigrations(db);

    const oldKey = db.prepare('SELECT value FROM config WHERE key = ?').get('epgp_channel_id');
    const newKey = db.prepare('SELECT value FROM config WHERE key = ?').get('epgp_rankings_channel_id') as
      | { value: string }
      | undefined;

    expect(oldKey).toBeUndefined();
    expect(newKey?.value).toBe('chan-123');
  });

  it('is idempotent when run a second time', () => {
    const db = getDatabase();
    db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run('epgp_channel_id', 'chan-123');

    runMigrations(db);
    runMigrations(db);

    const newKey = db.prepare('SELECT value FROM config WHERE key = ?').get('epgp_rankings_channel_id') as
      | { value: string }
      | undefined;
    expect(newKey?.value).toBe('chan-123');
  });

  it('does nothing when the old key is absent', () => {
    const db = getDatabase();
    db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run('epgp_rankings_channel_id', 'chan-999');

    runMigrations(db);

    const newKey = db.prepare('SELECT value FROM config WHERE key = ?').get('epgp_rankings_channel_id') as
      | { value: string }
      | undefined;
    expect(newKey?.value).toBe('chan-999');
  });

  it('does not overwrite an existing new-key value if both are set', () => {
    const db = getDatabase();
    db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run('epgp_channel_id', 'old-chan');
    db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run('epgp_rankings_channel_id', 'new-chan');

    runMigrations(db);

    const newKey = db.prepare('SELECT value FROM config WHERE key = ?').get('epgp_rankings_channel_id') as
      | { value: string }
      | undefined;
    expect(newKey?.value).toBe('new-chan');

    const oldKey = db.prepare('SELECT value FROM config WHERE key = ?').get('epgp_channel_id');
    expect(oldKey).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/db-migration.test.ts`
Expected: FAIL — old key isn't migrated.

- [ ] **Step 3: Add migration v2 to `runMigrations`**

Modify `src/database/db.ts`. Replace the `runMigrations` function:

```typescript
export function runMigrations(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = database
    .prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')
    .get() as { version: number } | undefined;

  const currentVersion = applied?.version ?? 0;

  if (currentVersion < 1) {
    database.prepare('INSERT INTO schema_version (version) VALUES (?)').run(1);
  }

  if (currentVersion < 2) {
    // Rename epgp_channel_id -> epgp_rankings_channel_id to match /setup's config key.
    database.exec(`
      INSERT OR IGNORE INTO config (key, value)
        SELECT 'epgp_rankings_channel_id', value
        FROM config
        WHERE key = 'epgp_channel_id';
      DELETE FROM config WHERE key = 'epgp_channel_id';
    `);
    database.prepare('INSERT INTO schema_version (version) VALUES (?)').run(2);
  }
}
```

- [ ] **Step 4: Update `createDisplayPost.ts` to read the new key**

In `src/functions/epgp/createDisplayPost.ts`, replace both occurrences of `'epgp_channel_id'` with `'epgp_rankings_channel_id'`. The warning message should also be updated:

```typescript
async function getEpgpChannel(client: Client): Promise<TextChannel | null> {
  const db = getDatabase();
  const channelConfig = db
    .prepare("SELECT value FROM config WHERE key = 'epgp_rankings_channel_id'")
    .get() as { value: string } | undefined;

  if (!channelConfig) {
    logger.warn('EPGP', 'No epgp_rankings_channel_id configured. Use /setup set_channel.');
    return null;
  }
  // ... rest unchanged
}
```

- [ ] **Step 5: Run all tests and build**

Run: `npm run build && npx vitest run`
Expected: Build succeeds; all tests pass (migration + channels + existing).

- [ ] **Step 6: Commit**

```bash
git add src/database/db.ts src/functions/epgp/createDisplayPost.ts tests/unit/db-migration.test.ts
git commit -m "fix(epgp): migrate epgp_channel_id to epgp_rankings_channel_id

createDisplayPost read from a key no /setup subcommand ever wrote to.
Idempotent migration v2 moves any existing value; new reads use the
same key /setup writes."
```

---

### Task 5: Refactor `trial-reviews` forum creation

**Files:**
- Modify: `src/functions/trial-review/createTrialReviewThread.ts`

- [ ] **Step 1: Replace `getOrCreateTrialForum` with a call to the helper**

In `src/functions/trial-review/createTrialReviewThread.ts`, replace the entire `getOrCreateTrialForum` function with:

```typescript
import { getOrCreateChannel } from '../channels.js';

async function getOrCreateTrialForum(client: Client): Promise<ForumChannel> {
  const guild = client.guilds.cache.get(config.guildId);
  if (!guild) throw new Error('Guild not found');

  const forum = await getOrCreateChannel(guild, {
    name: 'trial-reviews',
    type: ChannelType.GuildForum,
    categoryName: 'Overlords',
    configKey: 'trial_reviews_forum_id',
  });

  return forum as ForumChannel;
}
```

Remove the now-unused `getDatabase` import from this file if it has no other use.

- [ ] **Step 2: Build and verify**

Run: `npm run build && npx vitest run`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/functions/trial-review/createTrialReviewThread.ts
git commit -m "refactor(trials): use getOrCreateChannel for trial-reviews forum

trial-reviews now lands under the Overlords category (or warns if
missing and creates at top level). Also picks up any pre-existing
trial-reviews forum by name."
```

---

### Task 6: Refactor `application-log` forum creation

**Files:**
- Modify: `src/functions/applications/createForumPost.ts`

- [ ] **Step 1: Replace the inline forum lookup/create block with the helper**

In `src/functions/applications/createForumPost.ts`, replace lines 28–67 (from the `const db = getDatabase();` through the `if (!forum) { ... }` block) with:

```typescript
import { getOrCreateChannel } from '../channels.js';

// Replace the lookup-and-create block at the top of createForumPost with:
let forum: ForumChannel;
try {
  forum = (await getOrCreateChannel(guild, {
    name: 'application-log',
    type: ChannelType.GuildForum,
    categoryName: 'Application-logs',
    configKey: 'application_log_forum_id',
  })) as ForumChannel;
} catch (err) {
  const error = err instanceof Error ? err : new Error(String(err));
  throw new Error(`Failed to create application-log forum channel (does the bot have Manage Channels permission?): ${error.message}`);
}
```

Remove the now-unused top-of-function `const db = getDatabase();` if the rest of the function no longer uses it. Remove the now-unused `getDatabase` import if this file has no other use of it.

- [ ] **Step 2: Build and verify**

Run: `npm run build && npx vitest run`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/functions/applications/createForumPost.ts
git commit -m "refactor(applications): use getOrCreateChannel for application-log forum

application-log lands under Application-logs category (or warns).
Reuses any pre-existing application-log forum found by name."
```

---

### Task 7: Refactor `Applications` category + `app-{name}` channel

**Files:**
- Modify: `src/functions/applications/submitApplication.ts`

- [ ] **Step 1: Replace the Applications-category block with a helper call**

In `src/functions/applications/submitApplication.ts`, replace the entire block from `// Get or create applications category` through the end of the `if (!categoryId) { ... }` block (roughly lines 152–188) with:

```typescript
import { ChannelType } from 'discord.js';
import { getOrCreateChannel } from '../channels.js';

// Get or create applications category (by convention, only this call site uses
// type: GuildCategory; the helper itself does not enforce that restriction)
let categoryId: string;
try {
  const category = await getOrCreateChannel(guild, {
    name: 'Applications',
    type: ChannelType.GuildCategory,
    categoryName: null,
    configKey: 'applications_category_id',
  });
  categoryId = category.id;
} catch (err) {
  const error = err instanceof Error ? err : new Error(String(err));
  throw new Error(`Failed to create Applications category (does the bot have Manage Channels permission?): ${error.message}`);
}
```

The existing `guild.channels.create({ name: channelName, type: GuildText, parent: categoryId, permissionOverwrites, ... })` call for the per-application `app-{name}` channel below is unchanged — it still uses `parent: categoryId`.

- [ ] **Step 2: Build and verify**

Run: `npm run build && npx vitest run`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/functions/applications/submitApplication.ts
git commit -m "refactor(applications): use getOrCreateChannel for Applications category

By convention, only this call site uses type: GuildCategory, making it
the only category the bot creates. The constraint lives at the call
site, not inside the helper."
```

---

### Task 8: Refactor `raiders-lounge`

**Files:**
- Modify: `src/functions/raids/alertSignups.ts`

- [ ] **Step 1: Replace `getRaidersLoungeChannel` with a helper call**

In `src/functions/raids/alertSignups.ts`, replace the entire `getRaidersLoungeChannel` function with:

```typescript
import { getOrCreateChannel } from '../channels.js';

async function getRaidersLoungeChannel(client: Client): Promise<TextChannel | null> {
  try {
    const guild = await client.guilds.fetch(config.guildId);
    const channel = await getOrCreateChannel(guild, {
      name: 'raiders-lounge',
      type: ChannelType.GuildText,
      categoryName: 'Raiders',
      configKey: 'raiders_lounge_channel_id',
      createOptions: { topic: 'Raider signup alerts and discussion' },
    });
    return channel as TextChannel;
  } catch (error) {
    logger.error('AlertSignups', 'Failed to resolve raiders-lounge channel', error as Error);
    return null;
  }
}
```

Remove the unused `getDatabase` import and `ConfigRow` type import from this file if they're no longer referenced.

- [ ] **Step 2: Build and verify**

Run: `npm run build && npx vitest run`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/functions/raids/alertSignups.ts
git commit -m "refactor(raids): use getOrCreateChannel for raiders-lounge"
```

---

### Task 9: Refactor `weekly-check`

**Files:**
- Modify: `src/functions/raids/alertHighestMythicPlusDone.ts`

- [ ] **Step 1: Replace the inline lookup/create block with a helper call**

In `src/functions/raids/alertHighestMythicPlusDone.ts`, locate the channel resolution block (around lines 16–35). Replace it with:

```typescript
import { getOrCreateChannel } from '../channels.js';

// Inside the function body, replace the resolution block with:
const guild = await client.guilds.fetch(config.guildId);
const channel = (await getOrCreateChannel(guild, {
  name: 'weekly-check',
  type: ChannelType.GuildText,
  categoryName: 'Overlords',
  configKey: 'weekly_check_channel_id',
})) as TextChannel;
```

- [ ] **Step 2: Build and verify**

Run: `npm run build && npx vitest run`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/functions/raids/alertHighestMythicPlusDone.ts
git commit -m "refactor(raids): use getOrCreateChannel for weekly-check"
```

---

### Task 10: Refactor `raider-setup`

**Files:**
- Modify: `src/functions/raids/sendAlertForRaidersWithNoUser.ts`

- [ ] **Step 1: Replace the inline lookup/create block with a helper call**

In `src/functions/raids/sendAlertForRaidersWithNoUser.ts`, locate the channel resolution block (around lines 22–43). Replace it with:

```typescript
import { getOrCreateChannel } from '../channels.js';

// Inside the function body, replace the resolution block with:
const guild = await client.guilds.fetch(config.guildId);
const channel = (await getOrCreateChannel(guild, {
  name: 'raider-setup',
  type: ChannelType.GuildText,
  categoryName: 'SeriouslyCasual Bot',
  configKey: 'raider_setup_channel_id',
})) as TextChannel;
```

- [ ] **Step 2: Build and verify**

Run: `npm run build && npx vitest run`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/functions/raids/sendAlertForRaidersWithNoUser.ts
git commit -m "refactor(raids): use getOrCreateChannel for raider-setup"
```

---

### Task 11: Refactor `loot` channel

**Files:**
- Modify: `src/functions/loot/checkRaidExpansions.ts`

- [ ] **Step 1: Replace the inline lookup/create block with a helper call**

In `src/functions/loot/checkRaidExpansions.ts`, locate the channel resolution block (around lines 12–40). Replace it with:

```typescript
import { getOrCreateChannel } from '../channels.js';

// Inside the function body, replace the resolution block with:
const guild = await client.guilds.fetch(config.guildId);
const channel = (await getOrCreateChannel(guild, {
  name: 'loot',
  type: ChannelType.GuildText,
  categoryName: 'Raiders',
  configKey: 'loot_channel_id',
})) as TextChannel;
```

- [ ] **Step 2: Build and verify**

Run: `npm run build && npx vitest run`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/functions/loot/checkRaidExpansions.ts
git commit -m "refactor(loot): use getOrCreateChannel for loot channel"
```

---

### Task 12: Refactor `guild-info` channel with `welcome` alias

**Files:**
- Modify: `src/functions/guild-info/clearGuildInfo.ts`

- [ ] **Step 1: Replace the inline find/create block with a helper call**

In `src/functions/guild-info/clearGuildInfo.ts`, locate the block that scans for `welcome` or `guild-info` and optionally creates one. Replace it with:

```typescript
import { getOrCreateChannel } from '../channels.js';

// Inside the function body, replace the channel-resolution block with:
const channel = (await getOrCreateChannel(guild, {
  name: 'guild-info',
  type: ChannelType.GuildText,
  categoryName: null, // No target category; honor whatever parent the existing channel has
  configKey: 'guild_info_channel_id',
  aliasNames: ['welcome'],
})) as TextChannel;
```

- [ ] **Step 2: Build and verify**

Run: `npm run build && npx vitest run`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/functions/guild-info/clearGuildInfo.ts
git commit -m "refactor(guild-info): use getOrCreateChannel with welcome alias"
```

---

### Task 13: Startup wiring in `ready.ts` for bot-logs / bot-audit / epgp-rankings

**Files:**
- Modify: `src/events/ready.ts`

- [ ] **Step 1: Add imports**

At the top of `src/events/ready.ts`, add:

```typescript
import { ChannelType, type TextChannel } from 'discord.js';
import { config } from '../config.js';
import { getOrCreateChannel } from '../functions/channels.js';
import { setAuditChannel } from '../services/auditLog.js';
```

(Skip the imports that are already present.)

- [ ] **Step 2: Add the channel bootstrap block after `deployCommands()` and before scheduler registration**

In the `execute` function of the default export, after the `try { await deployCommands(); ... }` block and before `scheduler.registerInterval(...)`, insert:

```typescript
try {
  const guild = await client.guilds.fetch(config.guildId);

  const botLogsChannel = await getOrCreateChannel(guild, {
    name: 'bot-logs',
    type: ChannelType.GuildText,
    categoryName: 'SeriouslyCasual Bot',
    configKey: 'bot_logs_channel_id',
  });
  logger.setDiscordChannel(botLogsChannel as TextChannel);

  const botAuditChannel = await getOrCreateChannel(guild, {
    name: 'bot-audit',
    type: ChannelType.GuildText,
    categoryName: 'SeriouslyCasual Bot',
    configKey: 'bot_audit_channel_id',
  });
  setAuditChannel(botAuditChannel as TextChannel);

  await getOrCreateChannel(guild, {
    name: 'epgp-rankings',
    type: ChannelType.GuildText,
    categoryName: 'Raiders',
    configKey: 'epgp_rankings_channel_id',
  });

  logger.info('bot', 'Channel bootstrap complete');
} catch (error) {
  const err = error instanceof Error ? error : new Error(String(error));
  logger.error('bot', `Channel bootstrap failed: ${err.message}`, err);
}
```

- [ ] **Step 3: Build and verify**

Run: `npm run build && npx vitest run`
Expected: Build succeeds, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/events/ready.ts
git commit -m "feat(ready): auto-create bot-logs/bot-audit/epgp-rankings and wire services

Startup now resolves (or creates) the three ops channels and hands
bot-logs/bot-audit to the logger and audit services, which were
previously never connected to Discord even when configured."
```

---

### Task 14: Full build, test, and manual Chrome verification

**Files:** None (verification only)

- [ ] **Step 1: Full clean build and test**

Run: `npm run build && npm run test`
Expected: Build succeeds, all tests pass (channels + db-migration + existing).

- [ ] **Step 2: Start the bot against the test guild**

Run: `npm run dev`
Watch the console: expect "Channel bootstrap complete" INFO log followed by normal scheduler-startup logs. Expect no ERROR logs.

- [ ] **Step 3: Verify each channel is in the correct category**

In the test Discord server, confirm each channel sits under the expected category (or at top level if the category doesn't exist in your test server):

| Channel | Expected parent |
|---|---|
| `trial-reviews` | Overlords |
| `application-log` | Application-logs |
| `Applications` (category) | — |
| `app-*` | Applications |
| `raiders-lounge` | Raiders |
| `weekly-check` | Overlords |
| `raider-setup` | SeriouslyCasual Bot |
| `loot` | Raiders |
| `bot-logs` | SeriouslyCasual Bot |
| `bot-audit` | SeriouslyCasual Bot |
| `epgp-rankings` | Raiders |
| `guild-info` / `welcome` | (existing parent preserved) |

For any missing category in the test server, confirm a WARN log was produced and the channel landed at top level.

- [ ] **Step 4: Verify bot-logs actually receives output**

Check the `bot-logs` channel — every INFO-or-higher log from the bot should now appear there (`Logged in as ...`, `Commands registered`, `Channel bootstrap complete`, etc.).

- [ ] **Step 5: Verify bot-audit receives output on officer actions**

Run `/trials create_thread` (or any command that calls `audit()`). Confirm the audit line appears in `bot-audit`.

- [ ] **Step 6: Verify EPGP display works end-to-end**

Run `/epgp upload` with a sample JSON file (or use `/testdata seed_epgp`). Run `/epgp create_post`. Confirm the 3-message display lands in the `epgp-rankings` channel (under Raiders category).

- [ ] **Step 7: Verify existing-channel reuse**

In the test server, manually delete the config row for one channel (e.g., `sqlite3 db.sqlite "DELETE FROM config WHERE key = 'raiders_lounge_channel_id';"`) while the bot is stopped. Restart the bot and trigger an action that resolves the channel (e.g., wait for the next signup-alert cron, or manually call via code path). Confirm the existing channel is reused (not duplicated) and its ID gets re-stored in config.

- [ ] **Step 8: Final build check**

Run: `npm run build`
Expected: Build succeeds, no warnings beyond the normal CRLF line-ending notices.

---

## Notes for the Executor

- **Order matters for Tasks 1–4**: the helper and its tests must exist before any call-site refactor, and the DB migration must exist before any code that reads `epgp_rankings_channel_id`. Tasks 5–12 are independent of each other — they can be reordered freely, but each should be built-and-tested green before committing. Tasks 13 and 14 go last.
- **TDD discipline**: write the failing test first, run it to see it fail, then implement. Don't combine test+impl commits.
- **When a call-site refactor removes the last use of `getDatabase` in a file, drop that import too**. Same for `ChannelType` / `ConfigRow` where they become unused.
- **Do not change behavior beyond what the spec describes**. No opportunistic renames of channel names or config keys, no reordering of existing logic, no speculative refactors. If you find an unrelated bug while editing, note it and leave it alone.
- **After every commit, run the full test suite**. A task that red-greens locally but breaks a sibling test is not done until the sibling is green too.

---

## Post-review amendments

The plan above describes the initial implementation. Subsequent code review rounds on PR #31 added the following, which are now part of the merged helper in `src/functions/channels.ts`:

- **Three function overloads** keyed on `opts.type` so call sites don't cast the return value.
- **Inflight dedup** via a `WeakMap<Guild, Map<configKey, Promise>>` so concurrent calls for the same channel share one resolution.
- **Stale-config-ID logging** with distinct messages for "channel deleted" vs. "channel type changed".
- **Cache refresh with retry** — on a name-lookup miss, one full REST fetch per guild (shared across concurrent callers via an in-flight promise, retried on failure).
- **Wrong-type name-match warnings** fire regardless of whether a correct match resolves via an alias; duplicate-name-within-target warnings fire only when two correctly-typed channels share a single target name.
- **Deterministic alias priority** — `targets` are iterated in preference order (primary name beats aliases).
- **Target deduplication** so a caller passing `aliasNames` that include `opts.name` doesn't do redundant work.
- **Parent-for-category guard** — category creations never pass `parent`, even if `opts.createOptions.parent` is set.
- **Per-guild dedup of missing-category warnings** via `WeakMap<Guild, Set<string>>`.
- **Human-readable channel types in log messages** (`ChannelType[x]` stringification).
- **Migration v2 conflict warn** — `runMigrations` emits a `console.warn` when both the old and new EPGP config keys are present with different values.
- **Per-channel error isolation in `ready.ts`** via a local `tryBootstrap(name, fn)` helper; one channel's failure doesn't block the others.

The design spec at `docs/superpowers/specs/2026-04-18-channel-auto-creation-design.md` has been updated in-tree to reflect current behaviour.

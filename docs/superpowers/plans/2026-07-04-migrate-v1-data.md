# /migrate V1 Data Import — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an admin-only `/migrate` slash command that imports selected data from a V1 `db.sqlite` (a single `keyv` table) into the V2 schema and recreates the current raid tier's loot posts.

**Architecture:** Three testable layers — `parseV1Export` (read+decode the V1 keyv table), DB-only importers (`importIdentityMap`/`importOverlords`/`importIgnored`, idempotent via `INSERT OR IGNORE`), and a loot layer (`insertLootResponses` + `recreateLootPosts` that create Discord posts then persist rows, since `loot_posts.message_id` is `NOT NULL`). A thin `/migrate` command orchestrates them: download the uploaded attachment to a temp file, open it read-only, run the imports in a transaction, recreate loot posts, report a summary.

**Tech Stack:** TypeScript (ESM, Node16 module resolution — imports use `.js` extensions), discord.js v14, better-sqlite3, vitest.

**Spec:** `docs/superpowers/specs/2026-07-04-migrate-v1-data-design.md`

## Global Constraints

- ESM with Node16 resolution: **all local imports use the `.js` extension** even from `.ts` files.
- Use `MessageFlags.Ephemeral` (not `ephemeral: true`) for ephemeral replies.
- Use `withResponse: true` (not `fetchReply`) if a reply message is needed.
- Commands auto-load from `src/commands/` (see `src/loadCommands.ts`) and are deployed by `deploy-commands.ts` — no manual registration.
- Admin commands follow `/loot` and `/trials`: `setDefaultMemberPermissions(PermissionFlagsBits.Administrator)` **and** the `requireOfficer(interaction)` runtime guard.
- V2 response types map 1:1 to V1: `major` | `minor` | `wantIn` | `wantOut`.
- Current-tier boss ids (the only loot migrated as posts): `197132, 197133, 197134, 197135, 197136, 197137, 197138, 197139, 197140`.
- Do not use `Date.now()` for temp filenames in code that could run under test harnesses expecting determinism — use `interaction.id`.

---

### Task 1: `parseV1Export` — decode the V1 keyv table

**Files:**
- Create: `src/functions/migrate/parseV1Export.ts`
- Test: `tests/unit/migrate/parseV1Export.test.ts`

**Interfaces:**
- Consumes: a `better-sqlite3` `Database` handle opened on the V1 file.
- Produces:
  ```ts
  export const CURRENT_TIER_BOSS_IDS: readonly number[]; // the 9 ids above
  export interface V1IdentityEntry { characterName: string; discordUserId: string }
  export interface V1Overlord { name: string; userId: string }
  export interface V1Votes { major: string[]; minor: string[]; wantIn: string[]; wantOut: string[] }
  export interface V1LootPost { bossId: number; bossName: string; bossUrl: string | null; votes: V1Votes }
  export interface V1Export {
    identityMap: V1IdentityEntry[];
    overlords: V1Overlord[];
    ignored: string[];
    lootPosts: V1LootPost[]; // filtered to CURRENT_TIER_BOSS_IDS
  }
  export function parseV1Export(v1Db: Database.Database): V1Export
  ```

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/migrate/parseV1Export.test.ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { parseV1Export } from '../../../src/functions/migrate/parseV1Export.js';

function makeV1Db(): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE keyv (key TEXT PRIMARY KEY, value TEXT)');
  const put = (key: string, payload: unknown) =>
    db.prepare('INSERT INTO keyv (key, value) VALUES (?, ?)').run(
      key,
      JSON.stringify({ value: payload, expires: null }),
    );
  put('raiders:Eldrítch', '230118286229110784');
  put('overlords:Bing', '111111111111111111');
  // ignoredCharacters entries have NO `value` field in V1 — only `{expires:null}`.
  db.prepare('INSERT INTO keyv (key, value) VALUES (?, ?)').run(
    'ignoredCharacters:Ryann',
    JSON.stringify({ expires: null }),
  );
  put('lootResponses:197140', {
    major: ['u1', 'u2'], minor: ['u3'], wantIn: [], wantOut: ['u4'],
    bossName: 'Midnight Falls', bossUrl: 'https://x/mf', channelId: 'c', messageId: 'm',
  });
  // Old-tier boss must be filtered out.
  put('lootResponses:184972', {
    major: ['u9'], minor: [], wantIn: [], wantOut: [],
    bossName: 'Eranog', bossUrl: 'https://x/er', channelId: 'c', messageId: 'm',
  });
  return db;
}

describe('parseV1Export', () => {
  it('decodes identity map, overlords, ignored, and current-tier loot only', () => {
    const result = parseV1Export(makeV1Db());

    expect(result.identityMap).toEqual([
      { characterName: 'Eldrítch', discordUserId: '230118286229110784' },
    ]);
    expect(result.overlords).toEqual([{ name: 'Bing', userId: '111111111111111111' }]);
    expect(result.ignored).toEqual(['Ryann']);

    expect(result.lootPosts).toHaveLength(1);
    expect(result.lootPosts[0]).toEqual({
      bossId: 197140,
      bossName: 'Midnight Falls',
      bossUrl: 'https://x/mf',
      votes: { major: ['u1', 'u2'], minor: ['u3'], wantIn: [], wantOut: ['u4'] },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/migrate/parseV1Export.test.ts`
Expected: FAIL — cannot find module `parseV1Export.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/functions/migrate/parseV1Export.ts
import type Database from 'better-sqlite3';

export const CURRENT_TIER_BOSS_IDS: readonly number[] = [
  197132, 197133, 197134, 197135, 197136, 197137, 197138, 197139, 197140,
];

export interface V1IdentityEntry { characterName: string; discordUserId: string }
export interface V1Overlord { name: string; userId: string }
export interface V1Votes { major: string[]; minor: string[]; wantIn: string[]; wantOut: string[] }
export interface V1LootPost { bossId: number; bossName: string; bossUrl: string | null; votes: V1Votes }
export interface V1Export {
  identityMap: V1IdentityEntry[];
  overlords: V1Overlord[];
  ignored: string[];
  lootPosts: V1LootPost[];
}

interface KeyvEnvelope { value?: unknown }

function unwrap(raw: string): unknown {
  const parsed = JSON.parse(raw) as KeyvEnvelope;
  return parsed.value;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
}

export function parseV1Export(v1Db: Database.Database): V1Export {
  const rows = v1Db.prepare('SELECT key, value FROM keyv').all() as {
    key: string;
    value: string;
  }[];

  const out: V1Export = { identityMap: [], overlords: [], ignored: [], lootPosts: [] };
  const tier = new Set(CURRENT_TIER_BOSS_IDS);

  for (const { key, value } of rows) {
    const sep = key.indexOf(':');
    if (sep < 0) continue;
    const ns = key.slice(0, sep);
    const rest = key.slice(sep + 1);

    if (ns === 'raiders') {
      const id = unwrap(value);
      if (typeof id === 'string' && id) {
        out.identityMap.push({ characterName: rest, discordUserId: id });
      }
    } else if (ns === 'overlords') {
      const id = unwrap(value);
      if (typeof id === 'string' && id) {
        out.overlords.push({ name: rest, userId: id });
      }
    } else if (ns === 'ignoredCharacters') {
      out.ignored.push(rest);
    } else if (ns === 'lootResponses') {
      const bossId = Number(rest);
      if (!Number.isInteger(bossId) || !tier.has(bossId)) continue;
      const payload = unwrap(value) as Record<string, unknown> | undefined;
      if (!payload) continue;
      out.lootPosts.push({
        bossId,
        bossName: String(payload.bossName ?? ''),
        bossUrl: payload.bossUrl != null ? String(payload.bossUrl) : null,
        votes: {
          major: asStringArray(payload.major),
          minor: asStringArray(payload.minor),
          wantIn: asStringArray(payload.wantIn),
          wantOut: asStringArray(payload.wantOut),
        },
      });
    }
  }

  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/migrate/parseV1Export.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/functions/migrate/parseV1Export.ts tests/unit/migrate/parseV1Export.test.ts
git commit -m "feat(migrate): parse V1 keyv export into structured data"
```

---

### Task 2: DB-only importers (identity map, overlords, ignored)

**Files:**
- Create: `src/functions/migrate/importData.ts`
- Test: `tests/unit/migrate/importData.test.ts`

**Interfaces:**
- Consumes: `V1IdentityEntry[]`, `V1Overlord[]`, `string[]` from Task 1; a V2 `Database` handle.
- Produces:
  ```ts
  export interface ImportCount { inserted: number; skipped: number }
  export function importIdentityMap(db: Database.Database, entries: V1IdentityEntry[]): ImportCount
  export function importOverlords(db: Database.Database, overlords: V1Overlord[]): ImportCount
  export function importIgnored(db: Database.Database, names: string[]): ImportCount
  // Back-fill discord_user_id on EXISTING unlinked raiders from the identity map,
  // so the "missing users" linking dropdown clears regardless of /migrate ordering
  // relative to the first roster sync. Returns the number of raiders newly linked.
  export function backfillRaiderLinks(db: Database.Database, entries: V1IdentityEntry[]): number
  ```

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/migrate/importData.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createTables } from '../../../src/database/schema.js';
import {
  importIdentityMap,
  importOverlords,
  importIgnored,
  backfillRaiderLinks,
} from '../../../src/functions/migrate/importData.js';

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  createTables(db);
});

describe('importIdentityMap', () => {
  it('inserts entries and is idempotent on re-run', () => {
    const entries = [
      { characterName: 'Alpha', discordUserId: '1' },
      { characterName: 'Beta', discordUserId: '2' },
    ];
    const first = importIdentityMap(db, entries);
    expect(first).toEqual({ inserted: 2, skipped: 0 });

    const rows = db.prepare('SELECT character_name, discord_user_id FROM raider_identity_map ORDER BY character_name').all();
    expect(rows).toEqual([
      { character_name: 'Alpha', discord_user_id: '1' },
      { character_name: 'Beta', discord_user_id: '2' },
    ]);

    const second = importIdentityMap(db, entries);
    expect(second).toEqual({ inserted: 0, skipped: 2 });
  });
});

describe('importOverlords', () => {
  it('inserts overlords and skips duplicates by name', () => {
    const first = importOverlords(db, [{ name: 'Bing', userId: '9' }]);
    expect(first).toEqual({ inserted: 1, skipped: 0 });
    const second = importOverlords(db, [{ name: 'Bing', userId: '9' }]);
    expect(second).toEqual({ inserted: 0, skipped: 1 });
    expect(db.prepare('SELECT COUNT(*) c FROM overlords').get()).toEqual({ c: 1 });
  });
});

describe('importIgnored', () => {
  it('inserts ignored characters and skips duplicates', () => {
    const first = importIgnored(db, ['Ryann', 'Foo']);
    expect(first).toEqual({ inserted: 2, skipped: 0 });
    const second = importIgnored(db, ['Ryann']);
    expect(second).toEqual({ inserted: 0, skipped: 1 });
  });
});

describe('backfillRaiderLinks', () => {
  it('links existing unlinked raiders by case-insensitive name, without overwriting linked ones', () => {
    // Unlinked raider (matches map, different case), already-linked raider (must not change),
    // and an unlinked raider with no map entry (must stay null).
    db.prepare("INSERT INTO raiders (character_name, discord_user_id) VALUES ('eldrítch', NULL)").run();
    db.prepare("INSERT INTO raiders (character_name, discord_user_id) VALUES ('Bob', '999')").run();
    db.prepare("INSERT INTO raiders (character_name, discord_user_id) VALUES ('Nomatch', NULL)").run();

    const linked = backfillRaiderLinks(db, [
      { characterName: 'Eldrítch', discordUserId: '230118286229110784' },
      { characterName: 'Bob', discordUserId: '111' }, // Bob already linked → must be ignored
    ]);
    expect(linked).toBe(1);

    const eldritch = db.prepare("SELECT discord_user_id FROM raiders WHERE character_name = 'eldrítch'").get();
    expect(eldritch).toEqual({ discord_user_id: '230118286229110784' });
    const bob = db.prepare("SELECT discord_user_id FROM raiders WHERE character_name = 'Bob'").get();
    expect(bob).toEqual({ discord_user_id: '999' });
    const nomatch = db.prepare("SELECT discord_user_id FROM raiders WHERE character_name = 'Nomatch'").get();
    expect(nomatch).toEqual({ discord_user_id: null });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/migrate/importData.test.ts`
Expected: FAIL — cannot find module `importData.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/functions/migrate/importData.ts
import type Database from 'better-sqlite3';
import type { V1IdentityEntry, V1Overlord } from './parseV1Export.js';

export interface ImportCount { inserted: number; skipped: number }

export function importIdentityMap(db: Database.Database, entries: V1IdentityEntry[]): ImportCount {
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO raider_identity_map (character_name, discord_user_id) VALUES (?, ?)',
  );
  let inserted = 0;
  for (const e of entries) {
    inserted += stmt.run(e.characterName, e.discordUserId).changes;
  }
  return { inserted, skipped: entries.length - inserted };
}

export function importOverlords(db: Database.Database, overlords: V1Overlord[]): ImportCount {
  const stmt = db.prepare('INSERT OR IGNORE INTO overlords (name, user_id) VALUES (?, ?)');
  let inserted = 0;
  for (const o of overlords) {
    inserted += stmt.run(o.name, o.userId).changes;
  }
  return { inserted, skipped: overlords.length - inserted };
}

export function importIgnored(db: Database.Database, names: string[]): ImportCount {
  const stmt = db.prepare('INSERT OR IGNORE INTO ignored_characters (character_name) VALUES (?)');
  let inserted = 0;
  for (const n of names) {
    inserted += stmt.run(n).changes;
  }
  return { inserted, skipped: names.length - inserted };
}

export function backfillRaiderLinks(db: Database.Database, entries: V1IdentityEntry[]): number {
  // Only touch raiders that currently have no linked user; match by name
  // case-insensitively to mirror syncRaiders' lookup.
  const stmt = db.prepare(
    'UPDATE raiders SET discord_user_id = ? WHERE discord_user_id IS NULL AND lower(character_name) = lower(?)',
  );
  let linked = 0;
  for (const e of entries) {
    linked += stmt.run(e.discordUserId, e.characterName).changes;
  }
  return linked;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/migrate/importData.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/functions/migrate/importData.ts tests/unit/migrate/importData.test.ts
git commit -m "feat(migrate): DB importers + existing-raider link backfill"
```

---

### Task 3: Loot layer (`insertLootResponses` + `recreateLootPosts`)

**Files:**
- Create: `src/functions/migrate/recreateLootPosts.ts`
- Test: `tests/unit/migrate/recreateLootPosts.test.ts`

**Interfaces:**
- Consumes: `V1LootPost[]` from Task 1; `addLootPost` (`src/functions/loot/addLootPost.js`), `updateLootPost` (`src/functions/loot/updateLootPost.js`), `getOrCreateChannel` (`src/functions/channels.js`), `getDatabase` (`src/database/db.js`).
- Produces:
  ```ts
  export function insertLootResponses(db: Database.Database, lootPostId: number, votes: V1Votes): number // rows inserted
  export interface LootRecreateResult { created: number; skipped: number; failed: number }
  export async function recreateLootPosts(client: Client, lootPosts: V1LootPost[]): Promise<LootRecreateResult>
  ```

Notes for the implementer:
- `addLootPost(channel, { id, name, url })` sends the Discord message and inserts the `loot_posts` row. After it runs, look up the new row's `id` by `boss_id`.
- Migrated votes are stored by Discord user id; `updateLootPost` renders names from the `raiders` table, so freshly-migrated posts may show `Unknown` until roster sync + identity linking runs. That is expected, not a bug.
- Skip any boss whose `boss_id` already exists in `loot_posts` (idempotent re-run).

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/migrate/recreateLootPosts.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createTables } from '../../../src/database/schema.js';

// config.js throws at import if env vars are unset — mock it (no global env in unit tests).
vi.mock('../../../src/config.js', () => ({ config: { guildId: 'guild-1' } }));

// addLootPost mock inserts the loot_posts row into the shared in-memory DB,
// mirroring the real implementation, so the response-insert step can find it.
vi.mock('../../../src/functions/loot/addLootPost.js', () => ({
  addLootPost: vi.fn(async (_channel: unknown, boss: { id: number; name: string; url?: string }) => {
    const { getDatabase } = await import('../../../src/database/db.js');
    getDatabase()
      .prepare('INSERT INTO loot_posts (boss_id, boss_name, boss_url, channel_id, message_id) VALUES (?, ?, ?, ?, ?)')
      .run(boss.id, boss.name, boss.url ?? null, 'chan', `msg${boss.id}`);
  }),
}));
vi.mock('../../../src/functions/loot/updateLootPost.js', () => ({ updateLootPost: vi.fn(async () => {}) }));
vi.mock('../../../src/functions/channels.js', () => ({ getOrCreateChannel: vi.fn(async () => ({ id: 'loot-chan' })) }));

import { getDatabase, closeDatabase } from '../../../src/database/db.js';
import { insertLootResponses, recreateLootPosts } from '../../../src/functions/migrate/recreateLootPosts.js';

const post = {
  bossId: 197140,
  bossName: 'Midnight Falls',
  bossUrl: 'https://x/mf',
  votes: { major: ['u1', 'u2'], minor: ['u3'], wantIn: [], wantOut: ['u4'] },
};

beforeEach(() => {
  closeDatabase();
  createTables(getDatabase(':memory:'));
});

describe('insertLootResponses', () => {
  it('inserts one row per user per response type', () => {
    const db = getDatabase();
    db.prepare('INSERT INTO loot_posts (boss_id, boss_name, boss_url, channel_id, message_id) VALUES (?,?,?,?,?)')
      .run(1, 'B', null, 'c', 'm');
    const lootPostId = (db.prepare('SELECT id FROM loot_posts WHERE boss_id = 1').get() as { id: number }).id;

    const n = insertLootResponses(db, lootPostId, post.votes);
    expect(n).toBe(4);
    const rows = db.prepare('SELECT user_id, response_type FROM loot_responses ORDER BY user_id').all();
    expect(rows).toEqual([
      { user_id: 'u1', response_type: 'major' },
      { user_id: 'u2', response_type: 'major' },
      { user_id: 'u3', response_type: 'minor' },
      { user_id: 'u4', response_type: 'wantOut' },
    ]);
  });
});

describe('recreateLootPosts', () => {
  it('creates a post + responses, and skips a boss already present on re-run', async () => {
    const client = { guilds: { fetch: vi.fn(async () => ({ id: 'guild-1' })) } } as never;

    const first = await recreateLootPosts(client, [post]);
    expect(first).toEqual({ created: 1, skipped: 0, failed: 0 });
    expect(getDatabase().prepare('SELECT COUNT(*) c FROM loot_responses').get()).toEqual({ c: 4 });

    const second = await recreateLootPosts(client, [post]);
    expect(second).toEqual({ created: 0, skipped: 1, failed: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/migrate/recreateLootPosts.test.ts`
Expected: FAIL — cannot find module `recreateLootPosts.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/functions/migrate/recreateLootPosts.ts
import { ChannelType, type Client, type TextChannel } from 'discord.js';
import type Database from 'better-sqlite3';
import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';
import { config } from '../../config.js';
import { getOrCreateChannel } from '../channels.js';
import { addLootPost } from '../loot/addLootPost.js';
import { updateLootPost } from '../loot/updateLootPost.js';
import type { V1LootPost, V1Votes } from './parseV1Export.js';
import type { LootPostRow } from '../../types/index.js';

const RESPONSE_TYPES: (keyof V1Votes)[] = ['major', 'minor', 'wantIn', 'wantOut'];

export function insertLootResponses(db: Database.Database, lootPostId: number, votes: V1Votes): number {
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO loot_responses (loot_post_id, user_id, response_type) VALUES (?, ?, ?)',
  );
  let inserted = 0;
  for (const type of RESPONSE_TYPES) {
    for (const userId of votes[type]) {
      inserted += stmt.run(lootPostId, userId, type).changes;
    }
  }
  return inserted;
}

export interface LootRecreateResult { created: number; skipped: number; failed: number }

export async function recreateLootPosts(
  client: Client,
  lootPosts: V1LootPost[],
): Promise<LootRecreateResult> {
  const db = getDatabase();
  const result: LootRecreateResult = { created: 0, skipped: 0, failed: 0 };
  if (lootPosts.length === 0) return result;

  const guild = await client.guilds.fetch(config.guildId);
  const channel = (await getOrCreateChannel(guild, {
    name: 'loot',
    type: ChannelType.GuildText,
    categoryName: 'Raiders',
    configKey: 'loot_channel_id',
  })) as TextChannel;

  for (const post of lootPosts) {
    const existing = db.prepare('SELECT id FROM loot_posts WHERE boss_id = ?').get(post.bossId);
    if (existing) {
      result.skipped++;
      continue;
    }
    try {
      await addLootPost(channel, { id: post.bossId, name: post.bossName, url: post.bossUrl ?? undefined });
      const row = db.prepare('SELECT * FROM loot_posts WHERE boss_id = ?').get(post.bossId) as LootPostRow | undefined;
      if (!row) throw new Error(`loot_posts row missing after addLootPost for boss ${post.bossId}`);
      insertLootResponses(db, row.id, post.votes);
      await updateLootPost(client, post.bossId);
      result.created++;
    } catch (error) {
      result.failed++;
      logger.error('Migrate', `Failed to recreate loot post for boss ${post.bossId}`, error as Error);
    }
  }

  return result;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/migrate/recreateLootPosts.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/functions/migrate/recreateLootPosts.ts tests/unit/migrate/recreateLootPosts.test.ts
git commit -m "feat(migrate): recreate current-tier loot posts and votes"
```

---

### Task 4: `/migrate` command + validation test + docs

**Files:**
- Create: `src/commands/migrate.ts`
- Test: `tests/unit/migrate/command.test.ts`
- Modify: `docs/commands.md` (add a `/migrate` entry)

**Interfaces:**
- Consumes: `parseV1Export`, `importIdentityMap`/`importOverlords`/`importIgnored`, `recreateLootPosts`, `requireOfficer` (`src/utils.js`), `audit` (`src/services/auditLog.js`), `getDatabase` (`src/database/db.js`).
- Produces: a default-exported command object `{ data, execute }` auto-loaded from `src/commands/`.

Behaviour:
- Option `db_file` (required attachment). Reject when the filename doesn't end in `.sqlite`/`.db` or size exceeds 50 MB (`52_428_800`).
- Download to `join(tmpdir(), \`v1-migrate-${interaction.id}.sqlite\`)`, open read-only, verify a `keyv` table exists.
- Run the three DB imports in one `db.transaction(...)`, then `recreateLootPosts`.
- Always delete the temp file and close the V1 handle in `finally`.
- `audit(interaction.user, 'ran V1 migration', <summary>)` and reply (ephemeral) with the per-category counts.

- [ ] **Step 1: Write the failing test (validation branch only)**

```ts
// tests/unit/migrate/command.test.ts
import { describe, it, expect, vi } from 'vitest';

// config.js throws at import if env vars are unset; migrate.ts pulls it in transitively.
vi.mock('../../../src/config.js', () => ({ config: { guildId: 'guild-1' } }));
vi.mock('../../../src/utils.js', () => ({ requireOfficer: vi.fn(async () => true) }));
vi.mock('../../../src/services/auditLog.js', () => ({ audit: vi.fn(async () => {}) }));

import migrate from '../../../src/commands/migrate.js';

function fakeInteraction(fileName: string, size: number) {
  const replies: unknown[] = [];
  return {
    replies,
    id: 'interaction-1',
    user: { id: 'admin' },
    options: { getAttachment: () => ({ name: fileName, size, url: 'https://example/db' }) },
    reply: vi.fn(async (m: unknown) => { replies.push(m); }),
    deferReply: vi.fn(async () => {}),
    editReply: vi.fn(async (m: unknown) => { replies.push(m); }),
  };
}

describe('/migrate validation', () => {
  it('rejects a non-sqlite attachment', async () => {
    const interaction = fakeInteraction('notes.txt', 1000);
    await migrate.execute(interaction as never);
    const text = JSON.stringify(interaction.replies);
    expect(text).toMatch(/\.sqlite|\.db/i);
  });

  it('rejects an oversized attachment', async () => {
    const interaction = fakeInteraction('db.sqlite', 60 * 1024 * 1024);
    await migrate.execute(interaction as never);
    const text = JSON.stringify(interaction.replies);
    expect(text).toMatch(/too large|size/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/migrate/command.test.ts`
Expected: FAIL — cannot find module `migrate.js`.

- [ ] **Step 3: Write the command implementation**

```ts
// src/commands/migrate.ts
import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import Database from 'better-sqlite3';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getDatabase } from '../database/db.js';
import { requireOfficer } from '../utils.js';
import { audit } from '../services/auditLog.js';
import { logger } from '../services/logger.js';
import { parseV1Export } from '../functions/migrate/parseV1Export.js';
import {
  importIdentityMap,
  importOverlords,
  importIgnored,
  backfillRaiderLinks,
} from '../functions/migrate/importData.js';
import { recreateLootPosts } from '../functions/migrate/recreateLootPosts.js';

const MAX_BYTES = 52_428_800; // 50 MB

export default {
  data: new SlashCommandBuilder()
    .setName('migrate')
    .setDescription('Import data from a V1 database')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addAttachmentOption((opt) =>
      opt.setName('db_file').setDescription('The V1 db.sqlite file').setRequired(true),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    if (!(await requireOfficer(interaction))) return;

    const attachment = interaction.options.getAttachment('db_file', true);

    const name = attachment.name ?? '';
    if (!/\.(sqlite|db)$/i.test(name)) {
      await interaction.reply({
        content: 'Please upload a V1 `.sqlite` (or `.db`) database file.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (attachment.size > MAX_BYTES) {
      await interaction.reply({
        content: `That file is too large (${attachment.size} bytes; limit ${MAX_BYTES}).`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const tempPath = join(tmpdir(), `v1-migrate-${interaction.id}.sqlite`);
    let v1Db: Database.Database | null = null;

    try {
      const res = await fetch(attachment.url);
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
      writeFileSync(tempPath, Buffer.from(await res.arrayBuffer()));

      v1Db = new Database(tempPath, { readonly: true });
      const hasKeyv = v1Db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='keyv'")
        .get();
      if (!hasKeyv) throw new Error('This does not look like a V1 database (no `keyv` table).');

      const parsed = parseV1Export(v1Db);

      const db = getDatabase();
      const dbCounts = db.transaction(() => ({
        identity: importIdentityMap(db, parsed.identityMap),
        backfilled: backfillRaiderLinks(db, parsed.identityMap),
        overlords: importOverlords(db, parsed.overlords),
        ignored: importIgnored(db, parsed.ignored),
      }))();

      const loot = await recreateLootPosts(interaction.client, parsed.lootPosts);

      const summary =
        `**V1 migration complete**\n` +
        `• Identity map: ${dbCounts.identity.inserted} added, ${dbCounts.identity.skipped} already present\n` +
        `• Existing raiders re-linked: ${dbCounts.backfilled}\n` +
        `• Overlords: ${dbCounts.overlords.inserted} added, ${dbCounts.overlords.skipped} already present\n` +
        `• Ignored characters: ${dbCounts.ignored.inserted} added, ${dbCounts.ignored.skipped} already present\n` +
        `• Loot posts: ${loot.created} created, ${loot.skipped} skipped, ${loot.failed} failed\n` +
        `_(Loot posts show real names once roster sync + identity linking has run.)_`;

      await audit(interaction.user, 'ran V1 migration', summary.replace(/\n/g, ' '));
      await interaction.editReply({ content: summary });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('Migrate', 'V1 migration failed', err);
      await interaction.editReply({ content: `Migration failed: ${err.message}` });
    } finally {
      if (v1Db) {
        try { v1Db.close(); } catch { /* already closed */ }
      }
      try { unlinkSync(tempPath); } catch { /* no temp file to remove */ }
    }
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/migrate/command.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Add a docs entry**

In `docs/commands.md`, add a row/section for `/migrate` under the admin commands, matching the existing format:

```markdown
### `/migrate`
Admin only. One-time import from a V1 `db.sqlite` (uploaded as the `db_file` attachment): raider identity map, overlords, ignored characters, and the current raid tier's loot posts + votes. Idempotent — safe to re-run.
```

- [ ] **Step 6: Full check and commit**

Run: `npx vitest run tests/unit/migrate && npx tsc --noEmit`
Expected: all migrate tests PASS, no type errors.

```bash
git add src/commands/migrate.ts tests/unit/migrate/command.test.ts docs/commands.md
git commit -m "feat(migrate): add admin /migrate command wiring and docs"
```

---

### Task 5: Loot posts — show a Discord mention for unlinked voters (instead of "Unknown")

**Files:**
- Create: `src/functions/loot/resolveVoterLabel.ts`
- Modify: `src/functions/loot/updateLootPost.ts:42`
- Test: `tests/unit/loot/resolveVoterLabel.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  export function resolveVoterLabel(userToCharacter: Map<string, string>, userId: string): string
  ```

Rationale: a loot vote from a user who isn't a linked raider currently renders as the literal string `Unknown`. Show `<@userId>` instead so it resolves to the person. Loot responses render inside **embed fields**, and mentions in embeds are clickable but never send notifications — so this does not ping anyone when a post updates. This directly improves migrated loot posts, whose voters are often not yet linked.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/loot/resolveVoterLabel.test.ts
import { describe, it, expect } from 'vitest';
import { resolveVoterLabel } from '../../../src/functions/loot/resolveVoterLabel.js';

describe('resolveVoterLabel', () => {
  it('returns the character name when the user is a linked raider', () => {
    const map = new Map([['123', 'Thrall']]);
    expect(resolveVoterLabel(map, '123')).toBe('Thrall');
  });

  it('returns a Discord mention when the user is not linked', () => {
    const map = new Map<string, string>();
    expect(resolveVoterLabel(map, '456')).toBe('<@456>');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/loot/resolveVoterLabel.test.ts`
Expected: FAIL — cannot find module `resolveVoterLabel.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/functions/loot/resolveVoterLabel.ts
/**
 * Label for a loot voter: the linked raider's character name, or a Discord
 * mention (<@id>) when the user isn't a linked raider. Mentions inside embed
 * fields render as the user but do not notify, so this is safe on every update.
 */
export function resolveVoterLabel(userToCharacter: Map<string, string>, userId: string): string {
  return userToCharacter.get(userId) ?? `<@${userId}>`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/loot/resolveVoterLabel.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Use the helper in `updateLootPost`**

In `src/functions/loot/updateLootPost.ts`, add the import at the top with the other local imports (use the `.js` extension):

```ts
import { resolveVoterLabel } from './resolveVoterLabel.js';
```

Then replace the `Unknown` fallback line (currently line 42):

```ts
    const charName = userToCharacter.get(response.user_id) ?? 'Unknown';
```

with:

```ts
    const charName = resolveVoterLabel(userToCharacter, response.user_id);
```

- [ ] **Step 6: Run the loot tests + typecheck**

Run: `npx vitest run tests/unit/loot tests/unit/loot.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/functions/loot/resolveVoterLabel.ts src/functions/loot/updateLootPost.ts tests/unit/loot/resolveVoterLabel.test.ts
git commit -m "feat(loot): show Discord mention for unlinked voters instead of Unknown"
```

---

### Task 6: Full-suite verification + manual end-to-end note

**Files:** none (verification only).

- [ ] **Step 1: Run the entire unit suite and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests PASS, no type errors.

- [ ] **Step 2: Manual end-to-end verification (test server)**

The command's happy path (attachment download → read-only open → import → Discord posts) is not unit-tested end to end. On the **test server** (develop deploy):
1. Run `/migrate` and attach the real V1 `db.sqlite`.
2. Confirm the ephemeral summary shows non-zero identity/overlord/ignored counts and 9 loot posts created (0 on a second run).
3. Confirm 9 loot posts appear in the `loot` channel and re-running `/migrate` reports them all skipped.
4. Spot-check `raider_identity_map`, `overlords`, `ignored_characters` row counts via the live DB inspection method.

- [ ] **Step 3: No commit** (verification only).

---

## Self-Review

- **Spec coverage:** command surface (Task 4), attachment→temp→read-only open + `keyv` check (Task 4), `parseV1Export` with namespace decode + current-tier filter (Task 1), idempotent DB importers + existing-raider link backfill (Task 2), loot recreation with skip-existing (Task 3), transaction around DB-only imports + non-transactional loot (Task 4), error handling + temp cleanup (Task 4), skipped namespaces (encoded by omission in Task 1), testing at each layer (Tasks 1–4) + manual e2e (Task 5). Realm/`raidersRealms` intentionally not imported (Task 1 omits the `raidersRealms` namespace) — matches spec.
- **Placeholder scan:** none — every code step is complete.
- **Type consistency:** `V1IdentityEntry`/`V1Overlord`/`V1Votes`/`V1LootPost`/`V1Export` defined in Task 1 and consumed unchanged in Tasks 2–4; `ImportCount` (Task 2), `LootRecreateResult` (Task 3), `LootPostRow` (existing type) used consistently.

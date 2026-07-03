# Spec: `/migrate` — one-time V1→V2 data import

**Date:** 2026-07-04
**Status:** Approved, ready for implementation plan

## Goal

Provide an admin-only `/migrate` slash command that imports worthwhile data from a
SeriouslyCasualBot **V1** `db.sqlite` (a single `keyv` key-value table) into the V2
SQLite schema, and recreates the current raid tier's loot posts in Discord.

This is a **one-time** migration run by an officer after V2 goes live. It is idempotent
so it can be safely re-run.

## Source data (V1 `keyv` table)

V1 stores everything as `keyv` rows: `key = "<namespace>:<rest>"`, `value = JSON` with
shape `{ "value": <payload>, "expires": null }`.

Namespaces present and how they are handled:

| V1 namespace | Rows | Handling |
|---|---|---|
| `raiders:<charName>` → discord user id | 29 | → `raider_identity_map` |
| `raidersRealms:<charName>` → realm | 28 | **skipped** (roster sync provides realm; identity map has no realm column) |
| `overlords:<name>` → user id | 5 | → `overlords` |
| `ignoredCharacters:<charName>` | 8 | → `ignored_characters` |
| `lootResponses:<bossId>` → votes+meta | 52 (only last 9 migrated) | → `loot_posts` + `loot_responses` + Discord posts |
| `applicationVotes` | 506 | **skipped** (tied to dead V1 application messages) |
| `settings` | 4 | **skipped** (V1 signup-day toggles; out of selected scope) |
| `priorityLootPostConfig` | 3 | **skipped** (message ids for a V1 post that won't exist in V2) |
| `guildinfo` | 1 | **skipped** (V1 message id, irrelevant) |
| plain `keyv:<id>` | 5 | **skipped** (message→user mappings of unknown/dead purpose) |
| `trials` / `trialAlerts` | 3 / 3 | **skipped** — all concluded in 2024; the 2 current trials are created manually via `/trials create_thread` |

### Loot: "current tier" = the last 9 bosses

Ordered by boss id, the 52 loot posts span ~5 raid tiers. Only the newest tier is
migrated as live posts (ids `197132`–`197140`):

```
197132  Imperator Averzian
197133  Vorasius
197134  Fallen-King Salhadaar
197135  Vaelgor & Ezzorak
197136  Lightblinded Vanguard
197137  Crown of the Cosmos
197138  Chimaerus the Undreamt God
197139  Belo'ren, Child of Al'ar
197140  Midnight Falls
```

Each `lootResponses` payload has: `major` / `minor` / `wantIn` / `wantOut` (arrays of
Discord user ids — response types map **1:1** to V2), plus `bossName`, `bossUrl`,
`channelId`, `messageId`.

## Command surface

- Name: `migrate`, description "Import data from a V1 database".
- Permission: `setDefaultMemberPermissions(PermissionFlagsBits.Administrator)` + the
  `requireOfficer(interaction)` guard, matching `/loot` and `/trials`.
- Option: `db_file` — **required attachment**, the V1 `db.sqlite`.
- Reply: ephemeral, deferred; ends with a per-category summary.

## Flow

1. Defer reply (ephemeral).
2. Validate the attachment: name ends with `.sqlite`/`.db`, size under a sane cap
   (e.g. 50 MB). On failure → clear ephemeral error.
3. Download the attachment (`attachment.url`) to a temp file under `os.tmpdir()`.
4. Open it read-only with better-sqlite3. Verify a `keyv` table exists, else error
   "not a V1 database".
5. `parseV1Export(v1Db)` → structured object.
6. Run the DB-only imports inside a single transaction: identity map, overlords,
   ignored characters.
7. Recreate loot (not transactional — each post needs a Discord message id first):
   for each of the 9 current-tier bosses, create the Discord post, insert its
   `loot_posts` row (with the new `message_id`) and `loot_responses` rows, then
   re-render. Per-post failures are logged and don't abort the rest.
8. Delete the temp file (in a `finally`).
9. Edit the reply with the summary.

Note: `loot_posts.message_id` is `NOT NULL`, so a loot row cannot be written before its
Discord message exists — that's why loot is handled after (and outside) the DB-only
transaction, per boss.

## Architecture — separate parse / DB-import / Discord layers

Keeps the DB logic unit-testable without Discord.

- `parseV1Export(v1Db: Database): { identityMap, overlords, ignored, lootPosts }`
  - Reads the `keyv` table into a map, JSON-parses each `.value`, decodes namespaces.
  - Node/better-sqlite3 returns proper UTF-8, so names like `Eldrítch` come through
    correctly (the mojibake seen in a Python console is not present in Node).
  - `lootPosts` is filtered to the 9 current-tier boss ids.
- DB-only import functions (pure DB writes into V2, all **idempotent**):
  - `importIdentityMap(db, entries)` — `INSERT OR IGNORE INTO raider_identity_map`.
  - `backfillRaiderLinks(db, entries)` — set `discord_user_id` on **existing** raiders
    that are currently unlinked, matching by case-insensitive character name. This
    clears the "missing users" linking dropdown regardless of whether `/migrate` runs
    before or after the first roster sync (`syncRaiders` only auto-links raiders it
    inserts fresh, so already-present unlinked raiders would otherwise never pick up the
    migrated links). Never overwrites an already-linked raider.
  - `importOverlords(db, entries)` — `INSERT OR IGNORE INTO overlords`.
  - `importIgnored(db, names)` — `INSERT OR IGNORE INTO ignored_characters`.
- Loot layer (Discord + DB together, since `loot_posts.message_id` is `NOT NULL`):
  - `recreateLootPosts(client, lootPosts)` — resolve the V2 loot channel via
    `getOrCreateChannel(guild, { name: 'loot', categoryName: 'Raiders', configKey: 'loot_channel_id' })`;
    for each boss, **skip if its `boss_id` already exists in `loot_posts`**, otherwise
    create the message (reusing `addLootPost`), insert one `loot_responses` row per user
    per response type, then `updateLootPost` to render the migrated votes. Per-post
    failures are logged and do not abort the rest.

## Idempotency / re-run

`INSERT OR IGNORE` for identity map, overlords, ignored characters. Loot skips any
`boss_id` already present in `loot_posts` (no duplicate Discord posts). A second run
reports everything as "already present".

## Error handling

- Invalid/unreadable/oversized attachment, or missing `keyv` table → clear ephemeral
  error, no partial writes.
- Per-item decode/import errors are collected and surfaced in the summary rather than
  aborting the whole migration.
- Temp file always cleaned up in `finally`.

## Out of scope

- Trials (handled via existing `/trials create_thread`).
- `raidersRealms`, `applicationVotes`, `settings`, `priorityLootPostConfig`,
  `guildinfo`, plain `keyv` namespace.
- V1 `config.json` (contains live secrets — should be rotated independently; the
  command never reads it).

## Testing

- Unit tests build a small in-memory better-sqlite3 `keyv` fixture and assert:
  - `parseV1Export` decodes each in-scope namespace correctly and filters loot to the
    9 current-tier bosses.
  - each DB-only `import*` writes the expected V2 rows and is idempotent on a second run.
- `recreateLootPosts` tested with a mocked Discord client: asserts it skips bosses whose
  `boss_id` already exists, and otherwise writes the `loot_posts` + `loot_responses` rows
  matching the parsed votes.

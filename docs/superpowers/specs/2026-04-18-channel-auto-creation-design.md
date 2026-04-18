# Channel Auto-Creation & Category Mapping Design Spec

## Problem

Auto-created channels land in the wrong place:

1. Every `getOrCreate*` call site except the Applications-related ones creates channels **without a parent category**, so forums like `trial-reviews` and text channels like `raiders-lounge` appear at the top of the guild instead of under their intended categories.
2. Lookup is **config-ID-only**. If a pre-existing channel already has the right name (e.g., officers manually created `bot-logs`), the bot ignores it and creates a duplicate.
3. `logger.setDiscordChannel()` and `setAuditChannel()` are defined but **never called** — `bot-logs` and `bot-audit` receive no output even when the channels exist and are configured.
4. `/setup set_channel` stores the EPGP channel ID under `epgp_rankings_channel_id`, but `createDisplayPost.ts` reads `epgp_channel_id`. The two keys never meet.

## Intended Behavior

Every auto-created channel resolves through a single helper that:

- Reuses the channel referenced by its stored config ID.
- Falls back to a case-insensitive name search across the guild — if a channel with the target name exists *anywhere*, use it as-is (regardless of its current category).
- Falls back to creating the channel under a configured parent category.
- If the target category is missing from the guild, logs a warning and creates the channel parent-less (does not auto-create categories).

The helper creates whatever channel type it's asked for (text / forum / category) through the same code path. By convention, only the `Applications` entry uses `type: GuildCategory`, so it's the only category the bot ever creates. The constraint lives at the call sites, not inside the helper — the helper will happily create any `GuildCategory` it's asked for.

## Channel → Category Map

| Channel | Type | Category | Config key |
|---|---|---|---|
| `trial-reviews` | Forum | Overlords | `trial_reviews_forum_id` |
| `application-log` | Forum | Application-logs | `application_log_forum_id` |
| `Applications` | Category | — | `applications_category_id` (auto-created if missing) |
| `app-{name}` | Text | Applications (via the resolved category ID) | — (stored per-application in `applications.channel_id`) |
| `raiders-lounge` | Text | Raiders | `raiders_lounge_channel_id` |
| `weekly-check` | Text | Overlords | `weekly_check_channel_id` |
| `raider-setup` | Text | SeriouslyCasual Bot | `raider_setup_channel_id` |
| `loot` | Text | Raiders | `loot_channel_id` |
| `bot-logs` | Text | SeriouslyCasual Bot | `bot_logs_channel_id` |
| `bot-audit` | Text | SeriouslyCasual Bot | `bot_audit_channel_id` |
| `epgp-rankings` | Text | Raiders | `epgp_rankings_channel_id` |
| `guild-info` | Text | — (existing channel's parent preserved; accepts `welcome` as an alias name) | `guild_info_channel_id` |

## API

New module: **`src/functions/channels.ts`**

```ts
export function getCategoryByName(
  guild: Guild,
  name: string,
): CategoryChannel | null;

export interface GetOrCreateChannelOptions {
  name: string;
  type: ChannelType.GuildText | ChannelType.GuildForum | ChannelType.GuildCategory;
  categoryName: string | null;   // null = never set a parent (used by the Applications category itself)
  configKey: string;
  aliasNames?: string[];         // additional names accepted for name-lookup (used by guild-info)
  createOptions?: Partial<GuildChannelCreateOptions>;
}

export async function getOrCreateChannel(
  guild: Guild,
  opts: GetOrCreateChannelOptions,
): Promise<GuildBasedChannel>;
```

### Resolution order

1. **Stored config ID.** If `config[configKey]` is set, fetch. If the channel exists and its type matches, return it.
2. **Name lookup.** Search `guild.channels.cache` for a channel matching `opts.name` (or any `aliasNames`), case-insensitive. If a match exists with the expected type, write its ID to `config[configKey]` and return it. If a name match exists but its type is wrong (e.g., a text channel named `trial-reviews` when a forum is expected), log a `WARN` naming the conflicting channel and continue to step 3.
3. **Parent category resolution.**
   - If `categoryName` is `null`: skip; parent stays undefined. (Used by the `Applications` category entry, which has no parent.)
   - Call `getCategoryByName(guild, categoryName)`.
   - If found: use its ID as the parent.
   - If missing: log a `WARN` (deduplicated per process), proceed with no parent. The `Applications` category works only because it's requested as a top-level channel of type `GuildCategory` at the call site, so its creation happens in step 4 via the normal create path. By convention only that call site uses `type: GuildCategory`; the helper itself imposes no such restriction.
4. **Create.** `guild.channels.create({ name, type, parent, ...createOptions })`. Write the new ID to `config[configKey]`. Return the channel.

### Logging

- `INFO`: config-cache hit, name-lookup reuse, channel creation (including category creation when `type: GuildCategory` is passed).
- `WARN`: category missing, duplicate-name matches (logs every matched ID), wrong-typed channel with matching name (proceeds to create a new correctly-typed one).
- `ERROR`: create failure → rethrown so existing call-site error boundaries handle it.

Warnings for a missing category are deduplicated per process using a `Set<string>` to avoid log spam.

## Startup Wiring

In `src/events/ready.ts`, immediately after `deployCommands()` and before scheduler registration, add:

```ts
const guild = await client.guilds.fetch(config.guildId);

try {
  const botLogsChannel = await getOrCreateChannel(guild, {
    name: 'bot-logs', type: ChannelType.GuildText,
    categoryName: 'SeriouslyCasual Bot',
    configKey: 'bot_logs_channel_id',
  });
  logger.setDiscordChannel(botLogsChannel as TextChannel);

  const botAuditChannel = await getOrCreateChannel(guild, {
    name: 'bot-audit', type: ChannelType.GuildText,
    categoryName: 'SeriouslyCasual Bot',
    configKey: 'bot_audit_channel_id',
  });
  setAuditChannel(botAuditChannel as TextChannel);

  await getOrCreateChannel(guild, {
    name: 'epgp-rankings', type: ChannelType.GuildText,
    categoryName: 'Raiders',
    configKey: 'epgp_rankings_channel_id',
  });
} catch (error) {
  logger.error('bot', `Channel bootstrap failed: ${error}`, error as Error);
}
```

Failure is non-fatal — startup continues.

## EPGP Config Key Migration

`src/functions/epgp/createDisplayPost.ts`: change the read from `'epgp_channel_id'` to `'epgp_rankings_channel_id'`. Update the "No epgp_channel_id configured" warning text accordingly.

One-shot migration, idempotent, run in `initDatabase`:

```sql
INSERT OR IGNORE INTO config (key, value)
  SELECT 'epgp_rankings_channel_id', value FROM config WHERE key = 'epgp_channel_id';
DELETE FROM config WHERE key = 'epgp_channel_id';
```

## Call-Site Refactor

Each of the following has its bespoke `getOrCreate*` function removed or reduced to a single call to `getOrCreateChannel`:

- `src/functions/trial-review/createTrialReviewThread.ts` — replaces `getOrCreateTrialForum`
- `src/functions/applications/createForumPost.ts` — replaces inline forum lookup/create
- `src/functions/applications/submitApplication.ts` — replaces inline Applications category lookup/create (keep the `app-{name}` channel creation; it now passes the resolved category ID as `parent`)
- `src/functions/raids/alertSignups.ts` — replaces `getRaidersLoungeChannel`
- `src/functions/raids/alertHighestMythicPlusDone.ts` — replaces inline lookup/create
- `src/functions/raids/sendAlertForRaidersWithNoUser.ts` — replaces inline lookup/create
- `src/functions/loot/checkRaidExpansions.ts` — replaces inline lookup/create
- `src/functions/guild-info/clearGuildInfo.ts` — switches to helper with `aliasNames: ['welcome']`; preserves the existing channel's parent

The `app-{name}` channels use the helper indirectly: the Applications category is resolved via `getOrCreateChannel`, then each application's text channel is created via `guild.channels.create({ parent: categoryId, ... })` as today. A per-application helper is not introduced — the call site's permission-overwrite logic is too specific to justify sharing.

## Edge Cases

- **Duplicate names.** If multiple channels match the target name, pick the first from `guild.channels.cache`; log a `WARN` listing all matched IDs so officers can clean up.
- **Wrong-typed existing channel.** If the name matches but the type doesn't (e.g., `trial-reviews` exists as a text channel, not a forum), the helper ignores the mismatch and creates the correctly-typed channel under the target category. Warns.
- **Missing `Manage Channels` permission.** `guild.channels.create` throws; the error propagates to the caller.
- **Category exists but bot cannot see it.** `getCategoryByName` returns null; treated as missing (warn + parent-less create).
- **`categoryName: null`.** Skip category resolution. Used only by the `Applications` category entry.

## Tests

New file: `tests/unit/channels.test.ts`. All tests use mocked `Guild` / `channels.cache` / `channels.create` objects; no real Discord calls.

| Test | Expectation |
|---|---|
| Config ID hit | Returns the channel from cache; no create call |
| Stale config ID | Config key deleted; falls through to name lookup |
| Name match when config empty | Writes ID to config; returns channel |
| Name match is case-insensitive | `Trial-Reviews` matches target `trial-reviews` |
| Alias match | `aliasNames: ['welcome']` matches a channel named `welcome` |
| Parent category resolved | `create` called with `parent: <category.id>` |
| Missing category warn | `create` called with no parent; `logger.warn` invoked |
| Applications category auto-create | On missing category + `configKey === 'applications_category_id'`: new category created |
| Duplicate names warn | Picks first match; warn lists all matched IDs |
| Wrong-typed existing channel | Ignored; new correctly-typed channel created; warn logged |

Existing unit tests (pagination, testdata, EPGP parsing) are untouched.

## Out of Scope

- `/setup set_category` (manual category override command).
- Moving already-existing channels into the correct category (option C was chosen: use in place).
- Auto-creation of any category other than `Applications`.
- Reconciling channels whose names drift (e.g., someone renames `trial-reviews` → `trial-review`). Not currently possible to detect without ambiguity.

## Files Touched

**New:**
- `src/functions/channels.ts`
- `tests/unit/channels.test.ts`

**Modified:**
- `src/events/ready.ts`
- `src/functions/trial-review/createTrialReviewThread.ts`
- `src/functions/applications/createForumPost.ts`
- `src/functions/applications/submitApplication.ts`
- `src/functions/raids/alertSignups.ts`
- `src/functions/raids/alertHighestMythicPlusDone.ts`
- `src/functions/raids/sendAlertForRaidersWithNoUser.ts`
- `src/functions/loot/checkRaidExpansions.ts`
- `src/functions/guild-info/clearGuildInfo.ts`
- `src/functions/epgp/createDisplayPost.ts`
- `src/database/schema.ts` (or the location of `initDatabase`) — migration for `epgp_channel_id` → `epgp_rankings_channel_id`

Approximately 11 source files, 1 new test file, 1 migration.

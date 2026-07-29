# Achievements Image v2 — Design

**Date:** 2026-07-29
**Status:** Approved

## Summary

Rebuild the achievements image pipeline around Raider.IO's guild-profile and
live-tracking endpoints, cutting ~35 API calls per run to ~3–4, enrich the
image with raid/boss/expansion icons, add a per-boss live-progress breakdown
for in-progress raids, and cache immutable data in SQLite with a flush escape
hatch on `/updateachievements`.

## Background

The current implementation (`src/functions/guild-info/updateAchievements.ts`)
loops expansions 6+ calling `/raiding/static-data` per expansion and
`/raiding/raid-rankings?guilds=…` per raid (~35 calls per run), rendering a
text-only canvas table.

Investigation (2026-07-29) confirmed:

- The guild-profile endpoint accepts parameterised fields —
  `fields=raid_progression:6:7:…,raid_rankings:6:7:…` — returning kills per
  difficulty and world/region/realm ranks for every raid of the listed
  expansions in one call.
- `fields=raid_encounters:RAID_SLUG:mythic` returns per-boss `defeatedAt`
  timestamps (one raid per call; later `raid_encounters` fields override
  earlier ones).
- `/live-tracking/guild/raid-progress?raid=…&difficulty=mythic&period=until_kill`
  returns all bosses of a raid in one call with `pullCount`, `bestPercent`,
  `isDefeated`, and a per-boss `iconUrl`. Data exists for this guild from The
  War Within onwards (guild privacy shares everything).
- `/raiding/static-data` includes an `icon` name per raid. Icons resolve at
  `https://wow.zamimg.com/images/wow/icons/large/{icon}.jpg` — zamimg also
  serves numeric FileDataID icons (e.g. `8039569`), which Raider.IO's own CDN
  rejects.
- Expansions 1–5 have no data anywhere on Raider.IO (static-data empty, profile
  fields empty for both guild identities) — the manual rows stay.
- The guild spans two Raider.IO identities: **SeriouslyCasual / Silvermoon**
  (id 1061585, Shadowlands onward) and **Seriously Casual / Darksorrow**
  (id 43113, Legion/BfA). Both work with the profile endpoint.

## Goals

- Replace the per-raid fetch loop with the parameterised guild-profile calls.
- Add icons: raid rows, boss sub-rows, expansion headers, manual rows.
- Add a per-boss live breakdown (pulls, best %) for in-progress raids.
- Cache immutable data in SQLite; `/updateachievements flush:true` clears it.
- On any error, do not update the image.

## Non-goals

- Migrating `quipContext.ts` off `getRaidRankings` (it keeps using
  `RAIDERIO_GUILD_IDS`).
- Historical pull totals on past-raid rows (rejected in favour of a compact
  layout).
- Larger raid banner art (none publicly addressable — 56px icons only).

## Architecture

Option A from brainstorm: split into focused modules.

| Module | Responsibility |
| --- | --- |
| `src/services/apiCache.ts` (new) | Generic SQLite-backed cache: JSON payloads + icon blobs; flush. |
| `src/services/raiderio.ts` (extended) | New endpoint functions; existing functions untouched. |
| `src/functions/guild-info/achievementsData.ts` (new) | Fetch, merge identities, CE logic → plain data model. |
| `src/functions/guild-info/achievementsRender.ts` (new) | Data model → PNG buffer (canvas only). |
| `src/functions/guild-info/updateAchievements.ts` (slimmed) | Orchestration + Discord posting. |

### New raiderio.ts functions

```ts
interface GuildIdentity { region: string; realm: string; name: string }

getGuildRaidSummary(identity, expansionIds: number[])
  // guilds/profile?fields=raid_progression:IDs,raid_rankings:IDs
getGuildRaidEncounters(identity, raidSlug)
  // guilds/profile?fields=raid_encounters:SLUG:mythic
getLiveRaidProgress(identity, raidSlug)
  // live-tracking/guild/raid-progress?…&difficulty=mythic&period=until_kill
```

Identities come from a new env var `RAIDERIO_GUILDS`: JSON array of
`{region, realm, name}`, seeded with Silvermoon and Darksorrow entries.
`RAIDERIO_GUILD_IDS` remains (quips).

### Data flow per run (achievementsData.ts)

1. **Static data** per expansion 6..N (stop at first empty expansion), through
   the cache: past expansions forever, current expansion 7-day TTL. Supplies
   raid names, icons, display order (end date desc), tier end dates, and
   Fated/Awakened filtering (slug prefix `fated-`/`awakened-`).
2. **Guild profile** — two live calls (one per identity) with all expansion
   IDs. Merge per raid slug: take the identity with more mythic kills;
   tie-break on better non-zero mythic world rank. Rank 0 renders blank.
   Raids with zero mythic kills are omitted entirely (current behaviour).
3. **CE** per fully-cleared raid whose tier has **ended**: `raid_encounters`
   (cached forever — the data can no longer change). CE = all mythic bosses
   killed AND the final encounter's `defeatedAt` < tier end date (`ends.eu`).
   Fully-cleared raids in an **ongoing** tier count as CE without an
   encounters call. Implementation must verify `defeatedAt` reflects first
   kills by comparing a known past CE tier against the current image.
4. **Live breakdown** for current-expansion raids with mythic kills > 0 and
   < total: live `raid-progress` → per-boss rows (killed bosses' pull counts
   arrive in the same single call). Never cached — the data changes every
   raid night, and fully-cleared raids render as plain rows without a
   breakdown, so there is nothing to cache once a raid is done.
5. **Icons** resolved through `icon_cache`, fetching from zamimg on miss.

### Data model (input to renderer)

```ts
interface AchievementsModel {
  sections: Array<{
    expansionLabel: string;
    expansionIcon: string | null;    // icon name
    rows: Array<{
      raid: string;
      icon: string | null;           // icon name
      progress: string;              // "8/9M"
      isCE: boolean;
      worldRank: number;             // 0 = hide
      bosses?: Array<{               // present only for in-progress raids
        name: string;
        iconUrl: string | null;      // path from live API
        pulls: number;
        bestPercent: number;         // 0 when defeated
        defeated: boolean;
      }>;
    }>;
  }>;
  icons: Map<string, Buffer>;        // resolved images keyed by name/url
}
```

## Cache (schema migration v8)

```sql
CREATE TABLE api_cache (
  key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
CREATE TABLE icon_cache (
  name TEXT PRIMARY KEY,
  image BLOB NOT NULL,
  fetched_at TEXT NOT NULL
);
ALTER TABLE achievements_manual ADD COLUMN icon TEXT;
```

`apiCache.ts` API:

- `getCachedOrFetch<T>(key, ttl: number | 'forever', fetcher): Promise<T>`
- `getIconOrFetch(name: string, url: string): Promise<Buffer>`
- `flushCache(): void` — deletes all rows from both tables.

Key conventions: `static-data:{expansionId}`,
`encounters:{realm}:{raidSlug}`, `live-pulls:{raidSlug}`.

Cache policy:

| Data | Policy |
| --- | --- |
| Static data, past expansions | Forever |
| Static data, current expansion | 7-day TTL |
| Icons | Forever |
| `raid_encounters` (ended tiers) | Forever |
| `raid-progress` (in-progress raids only) | Never cached |
| Guild profile (progression + rankings) | Never cached |

The v8 migration backfills manual-row icons and seed.ts seeds the same:
Siege of Orgrimmar `achievement_boss_garrosh`, Highmaul
`achievement_boss_highmaul_king`, Blackrock Foundry
`achievement_boss_blackhand`, Hellfire Citadel
`achievement_boss_hellfire_archimonde`.

## Rendering

Canvas 1400px wide, background `#2b2d31`, bundled font (registered via
`registerAchievementsFonts()`), row height 44px (was 38).

- **Expansion header**: 28px icon + name in blurple `#5865f2`. Icon from a
  hardcoded map — MoP `expansionicon_mistsofpandaria`, WoD
  `achievement_zone_draenor_01`, Legion `achievement_faction_legionfall`,
  BfA `inv_heartofazeroth`, Shadowlands `inv_progenitor_runevessel` — else
  fall back to the expansion's newest raid icon from static data
  (Dragonflight, TWW, Midnight).
- **Raid row**: 32px raid icon, name, progress column, CE badge (existing
  green pill), world rank column (`WR {n}`, hidden when 0). CE rows keep the
  green text treatment.
- **Boss sub-row** (in-progress raids only): indented; 24px boss icon; name;
  killed bosses show a drawn ✓ path + `{pulls} pulls` in muted grey
  (`#96989d`); the prog boss shows a drawn ▶ triangle + `{pulls} pulls · best
  {x}%` highlighted gold (`#f0b232`). Glyphs are canvas paths, not font
  glyphs (bundled-font coverage is unverified; avoids the tofu failure mode).
- Missing icon → reserved blank space; column alignment unchanged. (A missing
  icon only occurs for rows whose source has no icon, e.g. a manual row with
  NULL icon — a failed fetch aborts the run, see Error handling.)

Layout (approved mock):

```
Midnight
 [icon] MN Tier 1 (VS/DR/MQD)   8/9M        WR 2281
    [icon] Imperator Averzian     ✓   7 pulls
    …
    [icon] Midnight Falls         ▶ 199 pulls · best 67.2%

The War Within
 [icon] Manaforge Omega          8/8M  [CE]  WR 1176
 …
```

## Command

`/updateachievements` gains an optional boolean `flush`; when true it calls
`flushCache()` before rebuilding and the ephemeral confirmation says the cache
was flushed. `/guildinfo` and the daily 06:30 cron are unchanged.

## Error handling

Fail-fast: any error — profile call, static data, encounters, live progress,
or icon download — aborts the entire update. The existing Discord message is
left untouched, the error is logged, the cron records the failure via
`recordTaskRun` (surfaced in `/status`), and the slash-command reply reports
the failure. No partial or degraded image is ever posted. (Cache writes that
completed before the failure are kept — they are valid data.)

## Testing

Mock `httpRequest` throughout; fixtures captured from the real API during
investigation.

- **Unit — apiCache**: TTL expiry, `'forever'` semantics, icon round-trip,
  flush empties both tables.
- **Unit — achievementsData**: identity merge (more kills wins; rank
  tie-break), CE cases (ongoing tier; ended tier killed before end; ended
  tier killed after end; not fully cleared), Fated/Awakened filtering,
  in-progress raid gets `bosses`, fully-cleared raid response cached forever,
  error propagation (any fetch failure rejects).
- **Unit — achievementsRender**: returns a valid non-empty PNG with expected
  dimensions for a fixture model; renders without icons (NULL icon rows).
- **E2E**: extend `updateachievements.e2e.ts` for `flush:true` (cache tables
  emptied, image reposted).
- **Manual**: deploy to test server; verify CE badges match the current prod
  image (validates `defeatedAt` first-kill semantics) before promoting.

## Decisions log

- Per-boss breakdown only for in-progress raids; historical rows stay compact
  (user choice, 2026-07-29).
- Cache in SQLite, immutable-forever + 7-day TTL for current-expansion static
  data; profile calls never cached (user approved). Self-review
  simplification: `raid-progress` is fetched only for in-progress raids and
  never cached — with the breakdown limited to in-progress raids, cleared
  raids never read live pulls, so the earlier cache-at-full-clear idea had
  nothing left to serve.
- Flush exposed as `/updateachievements flush:true` (user choice).
- Module split per Option A (user choice).
- Fail-fast error handling — never post a partial image (user instruction).

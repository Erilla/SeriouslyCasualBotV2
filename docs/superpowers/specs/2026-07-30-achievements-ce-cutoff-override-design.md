# Achievements CE Override Command and Legion Icon Fallback Design

## Purpose

Correct Cutting Edge classification when Raider.IO's generic raid end date does
not match Blizzard's CE-season cutoff, without hard-coding a raid-specific
override in the image-data source. Manaforge Omega is the first known case:
Raider.IO's end date extends to March 2026, while Blizzard announced that The
War Within Season Three Cutting Edge ended on 20 January 2026. Also supply the
five missing Legion raid-row icons omitted by Raider.IO static data.

## Design

Migration v10 will create a separate `achievement_ce_overrides` table keyed by
Raider.IO raid slug with an exclusive UTC `cutoff_at` value. This is business
data, not API cache data; `flushCache()` will continue to delete only
`api_cache` and `icon_cache`, so `/updateachievements flush:true` cannot remove
an override.

`/ceoverride set` will take a Raider.IO `raid` slug and a UTC `cutoff` date in
`YYYY-MM-DD` form—the first date that does not qualify for CE. It upserts the
override, records the normal audit event, and refreshes the achievements image.
`/ceoverride remove` deletes one override and refreshes the image. Both remain
officer-only. For Manaforge Omega, the intended command is
`/ceoverride set raid:manaforge-omega cutoff:2026-01-21`; the exclusive date
bound represents Blizzard's published 20 January end date without claiming a
precise shutdown time.

CE resolution will read an override from this table when one exists, otherwise
it will retain the current Raider.IO `ends.eu` behaviour. Static raid end dates
will continue to control ordering and cache freshness, so this change affects
only CE badges. A final-boss kill on or after the override cutoff will not
receive CE.

Raid icon resolution will retain Raider.IO's icon when present and otherwise
fall back by slug for the five Legion raids: Emerald Nightmare
(`achievement_emeraldnightmare_xavius`), Nighthold
(`achievement_thenighthold`), Trial of Valor
(`achievement_raid_trialofvalor`), Tomb of Sargeras
(`achievement_boss_kiljaeden2`), and Antorus
(`achievement_boss_argus_worldsoul`). The normal icon cache will fetch and
retain these assets.

## Error Handling and Testing

The command validates the date format before changing the database. An unknown
override removal reports that no override exists. If the image refresh fails
after a successful database change, the reply reports that the override was
saved but the refresh failed; the next refresh will still use the saved value.

Tests will cover migration, setting/removing an override, its survival through
a cache flush, CE resolution with and without an override, and Legion fallback
icons when Raider.IO omits them. Existing incomplete-raid and active-tier
behaviour remains unchanged.

## Scope

This does not add Blizzard OAuth, change raid ordering, alter historical manual
achievements, or modify the rendered layout.

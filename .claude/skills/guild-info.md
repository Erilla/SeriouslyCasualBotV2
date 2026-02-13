# Guild Info Embeds

## Files
- `src/commands/guildinfo.ts` - `/guildinfo` command (clears + reposts all embeds)
- `src/commands/updateachievements.ts` - `/updateachievements` command (refreshes achievements only)
- `src/functions/guild-info/clearGuildInfo.ts` - Deletes all messages in guild_info channel + clears DB
- `src/functions/guild-info/updateAboutUs.ts` - Posts About Us embed with link buttons
- `src/functions/guild-info/updateSchedule.ts` - Posts Raid Schedule embed
- `src/functions/guild-info/updateRecruitment.ts` - Posts Recruitment embed (replaces {{OVERLORDS}} token)
- `src/functions/guild-info/updateAchievements.ts` - Posts/edits achievements embed from Raider.io + JSON data

## Data files
- `data/aboutus.json` - Guild description + external links (Raider.io, WoWProgress, WarcraftLogs)
- `data/schedule.json` - Raid days, times, timezone
- `data/recruitment.json` - Recruitment sections, supports {{OVERLORDS}} token
- `data/achievements.json` - Manual achievements for old expansions (pre-expansion 6)

## How achievements work
1. Expansions < 6: Manual data from `data/achievements.json`
2. Expansions >= 6: Live data from Raider.io API (`getRaidStaticData` + `getRaidRankings`)
3. Achievements embed is stored via `guild_info` table (`achievements_message_id` key)
4. On update: tries to edit existing message, falls back to posting new one
5. Scheduled to auto-update every 30 minutes via BullMQ job

## Raider.io service
`src/services/raiderio.ts` provides:
- `getRaidRankings(raidSlug)` - World ranking for a specific raid
- `getRaidStaticData(expansionId)` - All raids + encounters for an expansion
- `getPreviousWeeklyHighestMythicPlusRun(region, realm, name)` - Character M+ data (Task 4)
- `getGuildRoster(region, realm, guildName)` - Guild members filtered to raider ranks (Task 4)

## Channel requirement
All functions require `guild_info` channel to be configured via `/setup set_channel`.
Functions return silently if not configured (graceful degradation).

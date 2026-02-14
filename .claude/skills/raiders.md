# Raider Management

## /raiders command (12 subcommands, admin-only)

### Roster management
- `get_raiders` - Shows all raiders with realm and Discord user
- `sync_raiders` - Syncs with Raider.io guild roster (adds new, removes departed)
- `check_missing_users` - Alerts in bot_setup channel for raiders without Discord user
- `update_raider_user` - Links a raider character to a Discord user

### Ignored characters
- `ignore_character` - Excludes character from roster sync (also removes from raiders)
- `remove_ignore_character` - Re-enables character for roster sync
- `get_ignored_characters` - Lists all ignored characters

### Overlords (guild leadership)
- `add_overlord` - Adds name + Discord user as overlord
- `remove_overlord` - Removes overlord by name
- `get_overlords` - Lists all overlords

### Weekly reports
- `previous_highest_mythicplus` - M+ dungeons from WoW Audit (file attachment)
- `previous_great_vault` - Great Vault options from WoW Audit (file attachment)

## Key files
- `src/commands/raiders.ts` - Slash command with all subcommands
- `src/functions/raids/syncRaiders.ts` - Core sync logic
- `src/functions/raids/getRaiders.ts` - DB queries for raiders
- `src/functions/raids/overlords.ts` - Overlord CRUD
- `src/functions/raids/ignoreCharacter.ts` - Ignore list CRUD
- `src/functions/raids/updateRaiderDiscordUser.ts` - Link raider to Discord user
- `src/functions/raids/sendAlertForRaidersWithNoUser.ts` - Missing user alerts
- `src/functions/raids/alertHighestMythicPlusDone.ts` - M+ and Great Vault reports
- `src/functions/addOverlordsToThread.ts` - Adds all overlords to a thread
- `src/services/wowaudit.ts` - WoW Audit API (getHistoricalData, getCurrentPeriod, getUpcomingRaids, getRaidDetails)

## Sync logic (syncRaiders)
1. Fetch stored raiders + ignored characters from DB
2. Fetch guild roster from Raider.io (filtered by rank: 0,1,3,4,5,7)
3. Remove stored raiders not in roster (or newly ignored)
4. Add new roster members not in DB
5. Update realm/region for existing raiders
6. Alert for new raiders missing Discord users
7. Post add/remove summary to bot_setup channel

## Scheduled jobs
- `syncRaiders` - every 10 minutes
- `weeklyReports` - noon Wednesday (sends both M+ and Great Vault reports to weekly_check channel)

## Database tables used
- `raiders` - character_name, discord_user_id, realm, region
- `overlords` - name, discord_user_id (UNIQUE)
- `ignored_characters` - character_name (UNIQUE)

## Channel config keys used
- `bot_setup` - Sync summaries and missing user alerts
- `weekly_check` - Weekly M+ and Great Vault reports

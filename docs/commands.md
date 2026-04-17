# Commands

All commands are Discord slash commands registered to a single guild.

## Command Reference

| Command | Description | Admin | Dev Only |
|---|---|---|---|
| `/ping` | Check bot latency and connection health | No | No |
| `/help` | List all available commands | No | No |
| `/status` | Show bot health, uptime, and scheduler status | No | No |
| `/loglevel get` | View current log level | Yes | No |
| `/loglevel set` | Change log level at runtime | Yes | No |
| `/settings get_setting` | View a specific feature toggle value | Yes | No |
| `/settings toggle_setting` | Toggle a feature on or off | Yes | No |
| `/settings get_all_settings` | View all feature toggle values | Yes | No |
| `/setup set_channel` | Assign a Discord channel to a bot purpose | Yes | No |
| `/setup set_role` | Assign a Discord role to a bot purpose | Yes | No |
| `/setup get_config` | View current channel/role configuration | Yes | No |
| `/raiders get_raiders` | List all tracked raiders | Yes | No |
| `/raiders get_ignored_characters` | List all ignored characters | Yes | No |
| `/raiders ignore_character` | Add a character to the ignore list (removes from raiders) | Yes | No |
| `/raiders remove_ignore_character` | Remove a character from the ignore list | Yes | No |
| `/raiders sync_raiders` | Manually trigger a Raider.io roster sync | Yes | No |
| `/raiders check_missing_users` | Find raiders without a linked Discord user and run auto-match | Yes | No |
| `/raiders update_raider_user` | Manually link a raider character to a Discord user | Yes | No |
| `/raiders previous_highest_mythicplus` | Generate last week's highest M+ run report as a file | Yes | No |
| `/raiders previous_great_vault` | Generate last week's Great Vault eligibility report as a file | Yes | No |
| `/raiders add_overlord` | Add an overlord (officer with special permissions) | Yes | No |
| `/raiders get_overlords` | List all configured overlords | Yes | No |
| `/raiders remove_overlord` | Remove an overlord | Yes | No |
| `/guildinfo` | Full refresh of all guild info embeds (About Us, Schedule, Recruitment, Achievements) | Yes | No |
| `/updateachievements` | Refresh the achievements embed only | Yes | No |
| `/apply` | Start a guild application via DM questionnaire | No | No |
| `/applications list_questions` | List all application questions | Yes | No |
| `/applications add_question` | Add a new application question | Yes | No |
| `/applications remove_question` | Remove an application question by ID | Yes | No |
| `/applications post_apply_button` | Post an "Apply Now" button embed in the current channel | Yes | No |
| `/applications view_pending` | View all pending applications (in_progress, active, abandoned) | Yes | No |
| `/applications set_accept_message` | Set the default acceptance DM message via modal | Yes | No |
| `/applications set_reject_message` | Set the default rejection DM message via modal | Yes | No |
| `/trials create_thread` | Open a modal to create a new trial review thread | Yes | No |
| `/trials get_current_trials` | View all active/promoted trials | Yes | No |
| `/trials remove_trial` | Close and archive a trial by thread ID | Yes | No |
| `/trials change_trial_info` | Update a trial's character name, role, or start date | Yes | No |
| `/trials update_trial_logs` | Refresh WarcraftLogs attendance for all active trials | Yes | No |
| `/trials update_trial_review_messages` | Refresh all trial review thread starter messages | Yes | No |
| `/loot create_posts` | Auto-discover current raid tier and create loot priority posts | Yes | No |
| `/loot delete_post` | Delete a single loot priority post by boss ID | Yes | No |
| `/loot delete_posts` | Delete multiple loot priority posts by comma-separated boss IDs | Yes | No |
| `/epgp upload` | Upload EPGP addon data (JSON file attachment) | Yes | No |
| `/epgp get_by_token` | View EPGP standings filtered by tier token (Zenith/Dreadful/Mystic/Venerated) | Yes | No |
| `/epgp get_by_armour` | View EPGP standings filtered by armour type (Cloth/Leather/Mail/Plate) | Yes | No |
| `/epgp create_post` | Create the 3-message EPGP display in the configured channel | Yes | No |
| `/epgp update_post` | Update the existing EPGP display messages | Yes | No |

## Notes

**Admin commands** require the `Administrator` Discord permission. They are hidden from non-admin members via `setDefaultMemberPermissions(PermissionFlagsBits.Administrator)` and enforce a runtime `requireOfficer()` check.

**Dev-only commands** are skipped at load time when `NODE_ENV=production`. No dev-only commands exist in the current foundation build.

## Adding a Command

1. Create `src/commands/<name>.ts` exporting a default `Command` object with `data` and `execute`.
2. Run `npm run deploy-commands` to register it with Discord.
3. For admin-only commands add `.setDefaultMemberPermissions(PermissionFlagsBits.Administrator)` to the builder and call `requireOfficer(interaction)` at the top of `execute`.
4. For dev-only commands set `devOnly: true` on the exported object.

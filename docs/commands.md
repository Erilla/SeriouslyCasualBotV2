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

## Notes

**Admin commands** require the `Administrator` Discord permission. They are hidden from non-admin members via `setDefaultMemberPermissions(PermissionFlagsBits.Administrator)` and enforce a runtime `requireOfficer()` check.

**Dev-only commands** are skipped at load time when `NODE_ENV=production`. No dev-only commands exist in the current foundation build.

## Adding a Command

1. Create `src/commands/<name>.ts` exporting a default `Command` object with `data` and `execute`.
2. Run `npm run deploy-commands` to register it with Discord.
3. For admin-only commands add `.setDefaultMemberPermissions(PermissionFlagsBits.Administrator)` to the builder and call `requireOfficer(interaction)` at the top of `execute`.
4. For dev-only commands set `devOnly: true` on the exported object.

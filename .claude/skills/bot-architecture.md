# Bot Architecture

## Startup sequence (src/index.ts)
1. `initLogger(config.logLevel)` - creates the console logger
2. `registerProcessErrorHandlers()` - last-resort `unhandledRejection` /
   `uncaughtException` logging
3. `initDatabase()` - creates/opens SQLite DB, runs migrations
4. Create the Discord `Client` (with intents + `Partials.Channel`)
5. `loadCommands()` - dynamically imports all `src/commands/*.ts`
6. Load events - inline loop importing each `src/events/*.ts`
7. Register `SIGTERM`/`SIGINT` shutdown handlers
8. `client.login()` (wrapped in try/catch; a login failure logs and exits 1)

## Ready event (src/events/ready.ts)
Handler for `clientReady` (`once: true`). After Discord connection:
1. `deployCommands()` - registers slash commands via the REST API
2. Channel bootstrap: find/create `bot-logs` (→ `logger.setDiscordChannel`) and
   `bot-audit` (→ `setAuditChannel`) under the "SeriouslyCasual Bot" category
3. Register scheduled tasks on the shared `scheduler` (see the scheduler skill)
4. `scheduler.start()`
5. `rescheduleAllAlerts(client)` - re-arms trial alerts from the DB
6. `resumeSessions(client)` - resumes in-progress DM application sessions

## Shutdown sequence (src/index.ts `shutdown()`)
1. Log shutdown message
2. `scheduler.shutdown()` - clears interval timers + stops cron jobs
3. `client.destroy()` - disconnects from Discord
4. `closeDatabase()` - closes SQLite connection
5. `process.exit(0)`

## Event handlers (src/events/)
- `ready.ts` - one-time setup on connect
- `interactionCreate.ts` - routes slash commands, buttons, modals, select menus
- `messageCreate.ts` - message-based handling (e.g. DM questionnaire replies)
- `threadUpdate.ts` - thread state changes (e.g. keep-alive / un-archive)

## File organization
```
src/
  commands/       # Slash command handlers (auto-loaded)
  events/         # Discord event handlers (loaded in index.ts)
  interactions/   # Button/modal/select-menu dispatch, registry, middleware
  database/       # SQLite setup, schema, migrations
  scheduler/      # node-cron based Scheduler class
  services/       # External API wrappers + logger, auditLog, statusTracker, httpClient
  functions/      # Business logic by domain (applications/, raids/, trial-review/, loot/, …)
  types/          # TypeScript interfaces and types
  config.ts       # Environment variable config
  utils.ts        # Core helpers (asSendable, requireOfficer, createEmbed, paginationRow)
  loadCommands.ts # Command loader
  processErrorHandlers.ts # Process-level error handlers
```

## Key conventions
- ESM: all imports use the `.js` extension (even for `.ts` source)
- Commands/events use the `export default` pattern
- Business logic lives in `src/functions/`, not in command files
- Interaction components (buttons/modals/selects) are routed through
  `src/interactions/` — register handlers there; use the `officerOnly` flag or
  `requireOfficer` for gated actions
- Config stored in DB via `/setup` (channel_config) and `/settings` (settings)
- Use `getChannel(key)` to resolve configured channels at runtime - always handle null
- Use `MessageFlags.Ephemeral` (not `ephemeral: true`) for ephemeral replies

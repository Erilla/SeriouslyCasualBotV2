# Bot Architecture

## Startup sequence (src/index.ts)
1. `setupGracefulShutdown()` - registers SIGTERM/SIGINT handlers
2. `initDatabase()` - creates/opens SQLite DB, runs migrations
3. `loadCommands()` - dynamically imports all `src/commands/*.ts`
4. `loadEvents()` - dynamically imports all `src/events/*.ts`
5. `client.login()` - connects to Discord

## Ready event (src/events/ready.ts)
After Discord connection:
1. `logger.init()` - creates/finds Logs category + channels in Discord
2. Auto-registers slash commands via REST API
3. Sets bot status based on `isSetupComplete()` check
4. Initializes audit log channel if configured
5. `initScheduler()` + `registerAllJobs()` - starts BullMQ

## Shutdown sequence
1. Log shutdown message
2. `closeScheduler()` - closes BullMQ worker + queue
3. `closeDatabase()` - closes SQLite connection
4. `client.destroy()` - disconnects from Discord

## Event handlers (src/events/)
- `ready.ts` - one-time setup on connect
- `interactionCreate.ts` - routes slash commands, buttons, modals, select menus

## File organization
```
src/
  commands/       # Slash command handlers (auto-loaded)
  events/         # Discord event handlers (auto-loaded)
  database/       # SQLite setup, schemas, migrations
  scheduler/      # BullMQ queue, worker, job definitions
  services/       # External API wrappers (logger, auditLog, raiderio, etc.)
  functions/      # Business logic by domain (settings/, setup/, etc.)
  types/          # TypeScript interfaces and types
  utils/          # Shared utilities (pagination, permissions)
  utils.ts        # Core helpers (asSendable, loadJson)
  config.ts       # Environment variable config
```

## Key conventions
- ESM: all imports use `.js` extension
- Commands/events use `export default` pattern
- Business logic in `src/functions/`, not in commands directly
- Config stored in DB via `/setup` (channel_config table) and `/settings` (settings table)
- Use `getChannel(key)` to resolve configured channels at runtime - always handle null

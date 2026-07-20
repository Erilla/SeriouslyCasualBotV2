# Database (better-sqlite3)

## Files
- `src/database/db.ts` - Singleton (`initDatabase()`, `getDatabase()`, `closeDatabase()`) **and** the inline versioned migrations (`runMigrations()`)
- `src/database/schema.ts` - `createTables()`: one idempotent SQL block of `CREATE TABLE IF NOT EXISTS` statements
- `src/database/seed.ts` / `seedApplicationQuestions.ts` - Default settings and application questions

## Usage

### Getting the DB instance
```ts
import { getDatabase } from '../database/db.js';
const db = getDatabase();
```
`initDatabase()` is called once in `src/index.ts` at startup (createTables → runMigrations → seeds). Always use `getDatabase()` after that.

### Querying
```ts
// Single row
const row = db.prepare('SELECT * FROM settings WHERE key = ?').get(key) as SettingRow | undefined;

// All rows
const rows = db.prepare('SELECT * FROM raiders ORDER BY character_name').all() as RaiderRow[];

// Insert/Update
db.prepare('INSERT INTO raiders (character_name, region) VALUES (?, ?)').run(name, region);

// Upsert
db.prepare('INSERT INTO table (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
```

### Adding a new table
1. Add the `CREATE TABLE IF NOT EXISTS` statement to the SQL block in `createTables()` (`schema.ts`) — this covers fresh databases
2. Add a migration (below) with the same DDL — this covers existing databases
3. Add the corresponding TypeScript row type in `src/types/index.ts`

### Adding a migration
Migrations are inline, forward-only version blocks in `runMigrations()` in `db.ts` — **not** separate files. Append a new block after the last one:
```ts
if (currentVersion < 9) {
  database.transaction(() => {
    database.exec('ALTER TABLE trials ADD COLUMN some_column TEXT');
    database.prepare('INSERT INTO schema_version (version) VALUES (?)').run(9);
  })();
}
```
Current head is version 8 (`build_info` — build-number cache, keyed by deployed commit SHA). Rules:
- Stay idempotent against fresh DBs where `createTables()` already produced the final schema (guard `ALTER` with a `table_info` check; use `IF EXISTS`/`IF NOT EXISTS`)
- Never modify or remove existing migration blocks
- Bump the hardcoded latest-version assertion in `tests/integration/database-schema.test.ts` (CI runs it)

## Configuration
- WAL mode enabled for concurrent reads
- Foreign keys enforced (`PRAGMA foreign_keys = ON`)
- DB file: `DB_PATH` env var (Railway: `/app/data/db.sqlite` on the volume), default `db.sqlite` in the project root (gitignored); `db.ts` creates the parent directory if missing

# Database (better-sqlite3)

## Files
- `src/database/database.ts` - Singleton: `initDatabase()`, `getDatabase()`, `closeDatabase()`
- `src/database/schema.ts` - Table schemas, default settings, default application questions
- `src/database/migrations.ts` - Versioned migration system

## Usage

### Getting the DB instance
```ts
import { getDatabase } from '../database/database.js';
const db = getDatabase();
```
`initDatabase()` is called once in `src/index.ts` at startup. Always use `getDatabase()` after that.

### Querying
```ts
// Single row
const row = db.prepare('SELECT * FROM settings WHERE key = ?').get(key) as SettingsRow | undefined;

// All rows
const rows = db.prepare('SELECT * FROM raiders ORDER BY character_name').all() as RaiderRow[];

// Insert/Update
db.prepare('INSERT INTO raiders (character_name, region) VALUES (?, ?)').run(name, region);

// Upsert
db.prepare('INSERT INTO table (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
```

### Adding a new table
1. Add the CREATE TABLE statement to `TABLE_SCHEMAS` array in `schema.ts`
2. Add the corresponding TypeScript row type in `src/types/index.ts`
3. Tables use `IF NOT EXISTS` so they're safe to re-run

### Adding a migration
Add to the `migrations` array in `migrations.ts`:
```ts
{
    version: 1,
    description: 'Add some_column to trials',
    up: (db) => {
        db.exec('ALTER TABLE trials ADD COLUMN some_column TEXT');
    },
}
```
Migrations run automatically on startup. Never modify or remove existing migrations.

## Configuration
- WAL mode enabled for concurrent reads
- Foreign keys enforced (`PRAGMA foreign_keys = ON`)
- DB file: `db.sqlite` in project root (gitignored)

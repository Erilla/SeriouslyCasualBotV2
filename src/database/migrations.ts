import type Database from 'better-sqlite3';

/**
 * Each migration has a version number and an `up` function that receives the DB instance.
 * Migrations run in order and are tracked in a `migrations` meta-table.
 */
export interface Migration {
    version: number;
    description: string;
    up: (db: Database.Database) => void;
}

/**
 * All migrations in order. Add new migrations to the end of this array.
 * Never modify or remove existing migrations.
 */
export const migrations: Migration[] = [
    {
        version: 1,
        description: 'Add created_at to application_sessions for session expiry',
        up: (db) => {
            db.exec("ALTER TABLE application_sessions ADD COLUMN created_at TEXT NOT NULL DEFAULT (datetime('now'))");
        },
    },
];

/**
 * Ensure the migrations tracking table exists.
 */
function ensureMigrationsTable(db: Database.Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS migrations (
            version INTEGER PRIMARY KEY,
            description TEXT NOT NULL,
            applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    `);
}

/**
 * Run all pending migrations in a transaction.
 * Returns the number of migrations applied.
 */
export function runMigrations(db: Database.Database): number {
    ensureMigrationsTable(db);

    const applied = new Set(
        db.prepare('SELECT version FROM migrations').all()
            .map((row) => (row as { version: number }).version)
    );

    let count = 0;

    for (const migration of migrations) {
        if (applied.has(migration.version)) continue;

        db.transaction(() => {
            migration.up(db);
            db.prepare('INSERT INTO migrations (version, description) VALUES (?, ?)')
                .run(migration.version, migration.description);
        })();

        console.log(`[DB] Applied migration v${migration.version}: ${migration.description}`);
        count++;
    }

    return count;
}

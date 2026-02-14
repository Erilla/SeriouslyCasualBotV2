import Database from 'better-sqlite3';
import { vi } from 'vitest';
import { TABLE_SCHEMAS } from '../../src/database/schema.js';

let testDb: Database.Database | null = null;

/**
 * Create an in-memory SQLite database with all schemas applied.
 * Mocks `getDatabase()` to return the test DB.
 */
export function setupTestDatabase(): Database.Database {
    testDb = new Database(':memory:');
    testDb.pragma('foreign_keys = ON');

    for (const schema of TABLE_SCHEMAS) {
        testDb.exec(schema);
    }

    vi.mock('../../src/database/database.js', () => ({
        getDatabase: () => {
            if (!testDb) throw new Error('Test database not initialized');
            return testDb;
        },
        initDatabase: vi.fn(),
        closeDatabase: vi.fn(),
    }));

    return testDb;
}

/**
 * Close and discard the in-memory test database.
 */
export function teardownTestDatabase(): void {
    if (testDb) {
        testDb.close();
        testDb = null;
    }
}

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TABLE_SCHEMAS, DEFAULT_SETTINGS, DEFAULT_APPLICATION_QUESTIONS } from './schema.js';
import { runMigrations } from './migrations.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.resolve(__dirname, '..', '..', 'db.sqlite');

let db: Database.Database | null = null;

/**
 * Initialize the database: create tables, seed defaults, run migrations.
 * Must be called once at startup before any DB access.
 */
export function initDatabase(): void {
    if (db) return;

    db = new Database(DB_PATH);

    // Enable WAL mode for better concurrent read performance
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Create all tables
    for (const schema of TABLE_SCHEMAS) {
        db.exec(schema);
    }

    // Seed default settings (only inserts if not already present)
    const insertSetting = db.prepare(
        'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
    );
    for (const { key, value } of DEFAULT_SETTINGS) {
        insertSetting.run(key, value);
    }

    // Seed default application questions
    const questionCount = db.prepare('SELECT COUNT(*) as count FROM application_questions').get() as { count: number };
    if (questionCount.count === 0) {
        const insertQuestion = db.prepare(
            'INSERT INTO application_questions (question_text, sort_order) VALUES (?, ?)'
        );
        for (let i = 0; i < DEFAULT_APPLICATION_QUESTIONS.length; i++) {
            insertQuestion.run(DEFAULT_APPLICATION_QUESTIONS[i], i);
        }
    }

    // Run any pending migrations
    const migrationCount = runMigrations(db);
    if (migrationCount > 0) {
        console.log(`[DB] Applied ${migrationCount} migration(s)`);
    }

    console.log(`[DB] Database initialized at ${DB_PATH}`);
}

/**
 * Get the database instance. Throws if initDatabase() hasn't been called.
 */
export function getDatabase(): Database.Database {
    if (!db) {
        throw new Error('Database not initialized. Call initDatabase() first.');
    }
    return db;
}

/**
 * Close the database connection. Call during graceful shutdown.
 */
export function closeDatabase(): void {
    if (db) {
        db.close();
        db = null;
        console.log('[DB] Database connection closed');
    }
}

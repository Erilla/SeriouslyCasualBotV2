import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { TABLE_SCHEMAS, DEFAULT_SETTINGS, DEFAULT_APPLICATION_QUESTIONS } from './schema.js';

describe('TABLE_SCHEMAS', () => {
    it('all schemas execute against in-memory DB without error', () => {
        const db = new Database(':memory:');
        db.pragma('foreign_keys = ON');

        for (const schema of TABLE_SCHEMAS) {
            expect(() => db.exec(schema)).not.toThrow();
        }

        db.close();
    });

    it('index CREATE statements succeed', () => {
        const db = new Database(':memory:');
        db.pragma('foreign_keys = ON');

        // Create all tables first so indexes can reference them
        for (const schema of TABLE_SCHEMAS) {
            db.exec(schema);
        }

        // Verify the indexes exist
        const indexes = db.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'"
        ).all() as { name: string }[];

        expect(indexes.length).toBeGreaterThanOrEqual(2);
        expect(indexes.map((i) => i.name)).toContain('idx_raiders_character_name');
        expect(indexes.map((i) => i.name)).toContain('idx_raiders_discord_user_id');

        db.close();
    });
});

describe('DEFAULT_SETTINGS', () => {
    it('has expected keys', () => {
        const keys = DEFAULT_SETTINGS.map((s) => s.key);
        expect(keys).toContain('alert_signups');
        expect(keys).toContain('alert_mythicplus');
        expect(keys).toContain('alert_trials');
        expect(keys).toContain('alert_applications');
        expect(keys).toContain('use_custom_applications');
    });
});

describe('DEFAULT_APPLICATION_QUESTIONS', () => {
    it('is non-empty string array', () => {
        expect(DEFAULT_APPLICATION_QUESTIONS.length).toBeGreaterThan(0);
        for (const q of DEFAULT_APPLICATION_QUESTIONS) {
            expect(typeof q).toBe('string');
            expect(q.length).toBeGreaterThan(0);
        }
    });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDatabase, teardownTestDatabase } from '../../../tests/helpers/testDatabase.js';
import { getSetting, getBooleanSetting } from './getSetting.js';

describe('getSetting', () => {
    beforeEach(() => setupTestDatabase());
    afterEach(() => teardownTestDatabase());

    it('returns null for missing key', () => {
        expect(getSetting('nonexistent')).toBeNull();
    });

    it('returns value when present', () => {
        const db = setupTestDatabase();
        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('test_key', 'test_value');
        expect(getSetting('test_key')).toBe('test_value');
    });
});

describe('getBooleanSetting', () => {
    beforeEach(() => setupTestDatabase());
    afterEach(() => teardownTestDatabase());

    it('returns true for "true" value', () => {
        const db = setupTestDatabase();
        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('flag', 'true');
        expect(getBooleanSetting('flag')).toBe(true);
    });

    it('returns false for "false" value', () => {
        const db = setupTestDatabase();
        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('flag', 'false');
        expect(getBooleanSetting('flag')).toBe(false);
    });

    it('returns false for any non-"true" value', () => {
        const db = setupTestDatabase();
        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('flag', 'yes');
        expect(getBooleanSetting('flag')).toBe(false);
    });

    it('returns false for missing key', () => {
        expect(getBooleanSetting('nonexistent')).toBe(false);
    });
});

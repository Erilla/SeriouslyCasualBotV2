import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDatabase, teardownTestDatabase } from '../../../tests/helpers/testDatabase.js';
import { setSetting, toggleSetting } from './setSetting.js';
import { getSetting } from './getSetting.js';

describe('setSetting', () => {
    beforeEach(() => setupTestDatabase());
    afterEach(() => teardownTestDatabase());

    it('creates a new key', () => {
        setSetting('new_key', 'hello');
        expect(getSetting('new_key')).toBe('hello');
    });

    it('upserts existing key', () => {
        setSetting('key1', 'original');
        setSetting('key1', 'updated');
        expect(getSetting('key1')).toBe('updated');
    });
});

describe('toggleSetting', () => {
    beforeEach(() => setupTestDatabase());
    afterEach(() => teardownTestDatabase());

    it('toggles false to true', () => {
        setSetting('toggle_key', 'false');
        const result = toggleSetting('toggle_key');
        expect(result).toBe(true);
        expect(getSetting('toggle_key')).toBe('true');
    });

    it('toggles true to false', () => {
        setSetting('toggle_key', 'true');
        const result = toggleSetting('toggle_key');
        expect(result).toBe(false);
        expect(getSetting('toggle_key')).toBe('false');
    });

    it('treats missing key as false and toggles to true', () => {
        const result = toggleSetting('missing_key');
        expect(result).toBe(true);
        expect(getSetting('missing_key')).toBe('true');
    });
});

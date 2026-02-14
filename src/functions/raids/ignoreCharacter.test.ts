import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDatabase, teardownTestDatabase } from '../../../tests/helpers/testDatabase.js';
import { ignoreCharacter, removeIgnoredCharacter, getIgnoredCharactersFormatted } from './ignoreCharacter.js';

describe('ignoreCharacter', () => {
    beforeEach(() => setupTestDatabase());
    afterEach(() => teardownTestDatabase());

    it('returns true on success', () => {
        expect(ignoreCharacter('BankAlt')).toBe(true);
    });

    it('returns false on duplicate', () => {
        ignoreCharacter('BankAlt');
        expect(ignoreCharacter('BankAlt')).toBe(false);
    });

    it('also deletes from raiders table', () => {
        const db = setupTestDatabase();
        db.prepare('INSERT INTO raiders (character_name, region) VALUES (?, ?)').run('BankAlt', 'eu');

        ignoreCharacter('BankAlt');

        const row = db.prepare('SELECT * FROM raiders WHERE LOWER(character_name) = LOWER(?)').get('BankAlt');
        expect(row).toBeUndefined();
    });
});

describe('removeIgnoredCharacter', () => {
    beforeEach(() => setupTestDatabase());
    afterEach(() => teardownTestDatabase());

    it('removes by case-insensitive match', () => {
        ignoreCharacter('BankAlt');
        expect(removeIgnoredCharacter('bankalt')).toBe(true);
    });

    it('returns false when not found', () => {
        expect(removeIgnoredCharacter('nobody')).toBe(false);
    });
});

describe('getIgnoredCharactersFormatted', () => {
    beforeEach(() => setupTestDatabase());
    afterEach(() => teardownTestDatabase());

    it('returns empty message when no ignored characters', () => {
        expect(getIgnoredCharactersFormatted()).toBe('No ignored characters.');
    });

    it('returns list of character names', () => {
        ignoreCharacter('Alt1');
        ignoreCharacter('Alt2');
        const formatted = getIgnoredCharactersFormatted();
        expect(formatted).toContain('Alt1');
        expect(formatted).toContain('Alt2');
    });
});

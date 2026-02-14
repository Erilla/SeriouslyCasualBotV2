import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDatabase, teardownTestDatabase } from '../../../tests/helpers/testDatabase.js';
import { getStoredRaiders, getRaidersFormatted } from './getRaiders.js';

describe('getStoredRaiders', () => {
    beforeEach(() => setupTestDatabase());
    afterEach(() => teardownTestDatabase());

    it('returns empty array when no raiders', () => {
        expect(getStoredRaiders()).toEqual([]);
    });

    it('returns sorted array of raiders', () => {
        const db = setupTestDatabase();
        db.prepare('INSERT INTO raiders (character_name, realm, region) VALUES (?, ?, ?)').run('Zara', 'Silvermoon', 'eu');
        db.prepare('INSERT INTO raiders (character_name, realm, region) VALUES (?, ?, ?)').run('Alpha', 'Silvermoon', 'eu');

        const raiders = getStoredRaiders();
        expect(raiders.length).toBe(2);
        expect(raiders[0].character_name).toBe('Alpha');
        expect(raiders[1].character_name).toBe('Zara');
    });
});

describe('getRaidersFormatted', () => {
    beforeEach(() => setupTestDatabase());
    afterEach(() => teardownTestDatabase());

    it('returns message when no raiders', () => {
        expect(getRaidersFormatted()).toBe('No raiders found.');
    });

    it('formats raiders with mentions and "no user"', () => {
        const db = setupTestDatabase();
        db.prepare('INSERT INTO raiders (character_name, discord_user_id, realm, region) VALUES (?, ?, ?, ?)').run(
            'TestChar', '12345', 'Silvermoon', 'eu',
        );
        db.prepare('INSERT INTO raiders (character_name, realm, region) VALUES (?, ?, ?)').run(
            'NoDiscord', 'Silvermoon', 'eu',
        );

        const formatted = getRaidersFormatted();
        expect(formatted).toContain('<@12345>');
        expect(formatted).toContain('*no user*');
        expect(formatted).toContain('TestChar');
        expect(formatted).toContain('NoDiscord');
    });
});

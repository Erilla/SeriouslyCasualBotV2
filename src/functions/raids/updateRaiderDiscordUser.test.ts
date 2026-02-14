import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDatabase, teardownTestDatabase } from '../../../tests/helpers/testDatabase.js';
import { updateRaiderDiscordUser, unmatchRaider } from './updateRaiderDiscordUser.js';

describe('updateRaiderDiscordUser', () => {
    beforeEach(() => setupTestDatabase());
    afterEach(() => teardownTestDatabase());

    it('updates discord user case-insensitively', () => {
        const db = setupTestDatabase();
        db.prepare('INSERT INTO raiders (character_name, region) VALUES (?, ?)').run('TestChar', 'eu');

        expect(updateRaiderDiscordUser('testchar', '12345')).toBe(true);

        const row = db.prepare('SELECT discord_user_id FROM raiders WHERE character_name = ?').get('TestChar') as { discord_user_id: string };
        expect(row.discord_user_id).toBe('12345');
    });

    it('returns false for nonexistent character', () => {
        expect(updateRaiderDiscordUser('nobody', '12345')).toBe(false);
    });
});

describe('unmatchRaider', () => {
    beforeEach(() => setupTestDatabase());
    afterEach(() => teardownTestDatabase());

    it('sets discord_user_id to NULL', () => {
        const db = setupTestDatabase();
        db.prepare('INSERT INTO raiders (character_name, discord_user_id, region) VALUES (?, ?, ?)').run('TestChar', '12345', 'eu');

        expect(unmatchRaider('TestChar')).toBe(true);

        const row = db.prepare('SELECT discord_user_id FROM raiders WHERE character_name = ?').get('TestChar') as { discord_user_id: string | null };
        expect(row.discord_user_id).toBeNull();
    });

    it('returns false for nonexistent character', () => {
        expect(unmatchRaider('nobody')).toBe(false);
    });
});

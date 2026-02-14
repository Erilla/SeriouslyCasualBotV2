import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDatabase, teardownTestDatabase } from '../../../tests/helpers/testDatabase.js';
import { getChannel, isSetupComplete } from './getChannel.js';

describe('getChannel', () => {
    beforeEach(() => setupTestDatabase());
    afterEach(() => teardownTestDatabase());

    it('returns null when key is missing', () => {
        expect(getChannel('nonexistent')).toBeNull();
    });

    it('returns channel_id when configured', () => {
        const db = setupTestDatabase();
        db.prepare('INSERT INTO channel_config (key, channel_id, guild_id) VALUES (?, ?, ?)').run(
            'guild_info', '123456', '999',
        );
        expect(getChannel('guild_info')).toBe('123456');
    });
});

describe('isSetupComplete', () => {
    beforeEach(() => setupTestDatabase());
    afterEach(() => teardownTestDatabase());

    it('returns false when no channels configured', () => {
        expect(isSetupComplete()).toBe(false);
    });

    it('returns true when any row exists', () => {
        const db = setupTestDatabase();
        db.prepare('INSERT INTO channel_config (key, channel_id, guild_id) VALUES (?, ?, ?)').run(
            'announcements', '111', '999',
        );
        expect(isSetupComplete()).toBe(true);
    });
});

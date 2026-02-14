import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDatabase, teardownTestDatabase } from '../../../tests/helpers/testDatabase.js';
import { addOverlord, removeOverlord, getOverlordsFormatted } from './overlords.js';

describe('addOverlord', () => {
    beforeEach(() => setupTestDatabase());
    afterEach(() => teardownTestDatabase());

    it('returns true on success', () => {
        expect(addOverlord('Officer1', '111')).toBe(true);
    });

    it('returns false on duplicate discord_user_id', () => {
        addOverlord('Officer1', '111');
        expect(addOverlord('Officer2', '111')).toBe(false);
    });
});

describe('removeOverlord', () => {
    beforeEach(() => setupTestDatabase());
    afterEach(() => teardownTestDatabase());

    it('removes by case-insensitive name match', () => {
        addOverlord('Officer1', '111');
        expect(removeOverlord('officer1')).toBe(true);
    });

    it('returns false when name not found', () => {
        expect(removeOverlord('nobody')).toBe(false);
    });
});

describe('getOverlordsFormatted', () => {
    beforeEach(() => setupTestDatabase());
    afterEach(() => teardownTestDatabase());

    it('returns empty message when no overlords', () => {
        expect(getOverlordsFormatted()).toBe('No overlords configured.');
    });

    it('formats overlords with mentions', () => {
        addOverlord('Boss', '999');
        const formatted = getOverlordsFormatted();
        expect(formatted).toContain('Boss');
        expect(formatted).toContain('<@999>');
    });
});

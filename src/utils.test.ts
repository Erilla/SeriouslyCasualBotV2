import { describe, it, expect } from 'vitest';
import { asSendable } from './utils.js';

describe('asSendable', () => {
    it('returns null for null input', () => {
        expect(asSendable(null)).toBeNull();
    });
});

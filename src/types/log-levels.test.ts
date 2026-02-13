import { describe, it, expect } from 'vitest';
import { LOG_LEVEL_ORDER } from './index.js';
import type { LogLevel } from './index.js';

describe('LOG_LEVEL_ORDER', () => {
    it('has correct ordering', () => {
        expect(LOG_LEVEL_ORDER.DEBUG).toBeLessThan(LOG_LEVEL_ORDER.INFO);
        expect(LOG_LEVEL_ORDER.INFO).toBeLessThan(LOG_LEVEL_ORDER.WARN);
        expect(LOG_LEVEL_ORDER.WARN).toBeLessThan(LOG_LEVEL_ORDER.ERROR);
        expect(LOG_LEVEL_ORDER.ERROR).toBeLessThan(LOG_LEVEL_ORDER.FATAL);
    });

    it('has all log levels defined', () => {
        const levels: LogLevel[] = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];
        for (const level of levels) {
            expect(LOG_LEVEL_ORDER[level]).toBeDefined();
            expect(typeof LOG_LEVEL_ORDER[level]).toBe('number');
        }
    });
});

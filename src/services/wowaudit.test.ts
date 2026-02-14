import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGet = vi.hoisted(() => vi.fn());

// Mock logger
vi.mock('./logger.js', () => ({
    logger: { warn: vi.fn().mockResolvedValue(undefined) },
}));

// Mock config
vi.mock('../config.js', () => ({
    config: {
        wowAuditApiSecret: 'test-secret',
    },
}));

// Mock axios
vi.mock('axios', () => ({
    default: {
        create: () => ({ get: mockGet }),
    },
}));

import { getUpcomingRaids, getRaidDetails, getCurrentPeriod, getHistoricalData } from './wowaudit.js';

describe('getUpcomingRaids', () => {
    beforeEach(() => {
        mockGet.mockReset();
    });

    it('returns raids on success', async () => {
        const raids = [{ id: 1, date: '2025-01-01', title: 'Raid Night' }];
        mockGet.mockResolvedValue({ data: { raids } });

        const result = await getUpcomingRaids();
        expect(result).toEqual(raids);
    });

    it('returns null on error', async () => {
        mockGet.mockRejectedValue(new Error('Timeout'));
        const result = await getUpcomingRaids();
        expect(result).toBeNull();
    });

    it('sends Authorization header', async () => {
        mockGet.mockResolvedValue({ data: { raids: [] } });
        await getUpcomingRaids();
        expect(mockGet).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
                headers: expect.objectContaining({ Authorization: 'test-secret' }),
            }),
        );
    });
});

describe('getRaidDetails', () => {
    beforeEach(() => {
        mockGet.mockReset();
    });

    it('returns data with id in URL', async () => {
        mockGet.mockResolvedValue({ data: { id: 42, title: 'Test Raid' } });

        const result = await getRaidDetails(42);
        expect(result).toEqual({ id: 42, title: 'Test Raid' });
        expect(mockGet).toHaveBeenCalledWith(
            expect.stringContaining('/raids/42'),
            expect.any(Object),
        );
    });

    it('returns null on error', async () => {
        mockGet.mockRejectedValue(new Error('Not found'));
        const result = await getRaidDetails(999);
        expect(result).toBeNull();
    });
});

describe('getCurrentPeriod', () => {
    beforeEach(() => {
        mockGet.mockReset();
    });

    it('returns current period number', async () => {
        mockGet.mockResolvedValue({ data: { current_period: 15 } });
        const result = await getCurrentPeriod();
        expect(result).toBe(15);
    });

    it('returns null on error', async () => {
        mockGet.mockRejectedValue(new Error('Timeout'));
        const result = await getCurrentPeriod();
        expect(result).toBeNull();
    });
});

describe('getHistoricalData', () => {
    beforeEach(() => {
        mockGet.mockReset();
    });

    it('chains getCurrentPeriod then fetches previous period', async () => {
        // First call: getCurrentPeriod → /period
        // Second call: getHistoricalData → /historical_data?period=14
        mockGet
            .mockResolvedValueOnce({ data: { current_period: 15 } })
            .mockResolvedValueOnce({ data: { characters: [{ name: 'TestChar', data: null }] } });

        const result = await getHistoricalData();
        expect(result).toEqual([{ name: 'TestChar', data: null }]);
        expect(mockGet).toHaveBeenCalledTimes(2);
        expect(mockGet).toHaveBeenNthCalledWith(2,
            expect.stringContaining('period=14'),
            expect.any(Object),
        );
    });

    it('returns null if getCurrentPeriod fails', async () => {
        mockGet.mockRejectedValue(new Error('Timeout'));
        const result = await getHistoricalData();
        expect(result).toBeNull();
    });
});

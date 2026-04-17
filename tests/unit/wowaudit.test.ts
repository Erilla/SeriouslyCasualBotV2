import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../src/config.js', () => ({
  config: {
    wowAuditApiSecret: 'test-api-secret',
  },
}));

import { getUpcomingRaids, getHistoricalData } from '../../src/services/wowaudit.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('getUpcomingRaids', () => {
  it('should fetch upcoming raids with correct headers', async () => {
    const mockRaids = [
      { id: 1, date: '2026-04-20', title: 'Raid Night', note: '', signups: [] },
    ];

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockRaids,
    });

    const result = await getUpcomingRaids();

    expect(result).toEqual(mockRaids);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://wowaudit.com/v1/raids?include_past=false',
      {
        headers: {
          accept: 'application/json',
          Authorization: 'test-api-secret',
        },
      },
    );
  });

  it('should throw on non-OK response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    });

    await expect(getUpcomingRaids()).rejects.toThrow('WoW Audit API error: 401 Unauthorized');
  });
});

describe('getHistoricalData', () => {
  it('should fetch historical data for the previous period', async () => {
    const mockHistorical = [
      { character: { name: 'Testchar', realm: 'silvermoon' }, data: { ilvl: 620 } },
    ];

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        // getCurrentPeriod call
        ok: true,
        json: async () => ({ current_period: 42 }),
      })
      .mockResolvedValueOnce({
        // getHistoricalData call
        ok: true,
        json: async () => mockHistorical,
      });

    const result = await getHistoricalData();

    expect(result).toEqual(mockHistorical);

    // First call: getCurrentPeriod
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://wowaudit.com/v1/period',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'test-api-secret' }),
      }),
    );

    // Second call: historical data with previous period (42 - 1 = 41)
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://wowaudit.com/v1/historical_data?period=41',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'test-api-secret' }),
      }),
    );
  });

  it('should throw if getCurrentPeriod fails', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });

    await expect(getHistoricalData()).rejects.toThrow('WoW Audit API error: 500 Internal Server Error');
  });

  it('should throw if historical data request fails', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ current_period: 42 }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });

    await expect(getHistoricalData()).rejects.toThrow('WoW Audit API error: 404 Not Found');
  });
});

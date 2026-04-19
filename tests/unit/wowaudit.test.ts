import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/config.js', () => ({
  config: {
    wowAuditApiSecret: 'test-api-secret',
  },
}));

import { getUpcomingRaids, getHistoricalData } from '../../src/services/wowaudit.js';
import { __resetForTests } from '../../src/services/apiHealth.js';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.restoreAllMocks();
  __resetForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('getUpcomingRaids', () => {
  it('should fetch upcoming raids with correct headers', async () => {
    const mockRaids = [
      { id: 1, date: '2026-04-20', title: 'Raid Night', note: '', signups: [] },
    ];

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: async () => mockRaids,
    });

    const result = await getUpcomingRaids();

    expect(result).toEqual(mockRaids);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://wowaudit.com/v1/raids?include_past=false',
      expect.objectContaining({
        headers: expect.objectContaining({
          accept: 'application/json',
          Authorization: 'test-api-secret',
        }),
      }),
    );
  });

  it('throws HttpError without retry on 401', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false, status: 401, statusText: 'Unauthorized', headers: new Headers(),
    });
    globalThis.fetch = fetchMock;

    await expect(getUpcomingRaids()).rejects.toThrow('wowaudit');
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
        headers: new Headers(),
        json: async () => ({ current_period: 42 }),
      })
      .mockResolvedValueOnce({
        // getHistoricalData call
        ok: true,
        headers: new Headers(),
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

  it('retries on 500 from getCurrentPeriod and throws HttpError', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false, status: 500, statusText: 'Internal Server Error',
      headers: new Headers(),
    });
    globalThis.fetch = fetchMock;

    const promise = getHistoricalData().catch((e) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    const err = await promise;

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('wowaudit');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it('throws HttpError without retry when historical data returns 404', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true, headers: new Headers(),
        json: async () => ({ current_period: 42 }),
      })
      .mockResolvedValueOnce({
        ok: false, status: 404, statusText: 'Not Found', headers: new Headers(),
      });
    globalThis.fetch = fetchMock;

    await expect(getHistoricalData()).rejects.toThrow('wowaudit');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

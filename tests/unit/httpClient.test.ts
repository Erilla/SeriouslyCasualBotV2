import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { __resetForTests } from '../../src/services/apiHealth.js';
import {
  httpRequest,
  HttpError,
} from '../../src/services/httpClient.js';
import { getSummary } from '../../src/services/apiHealth.js';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  __resetForTests();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-19T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockResponse(init: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  json?: unknown;
  headers?: Record<string, string>;
}): Response {
  const headers = new Headers(init.headers);
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    headers,
    json: async () => init.json ?? {},
  } as unknown as Response;
}

describe('httpRequest — happy path', () => {
  it('returns parsed JSON on 200', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse({ ok: true, json: { hello: 'world' } }),
    );

    const result = await httpRequest<{ hello: string }>('raiderio', 'https://x.test/');
    expect(result).toEqual({ hello: 'world' });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('records an ok outcome on success', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse({ ok: true, json: {} }));
    await httpRequest('raiderio', 'https://x.test/');
    expect(getSummary('raiderio').totals.ok).toBe(1);
  });
});

describe('httpRequest — non-retryable failures', () => {
  it.each([400, 401, 403, 404, 410, 422])(
    'throws HttpError immediately on %s without retry',
    async (status) => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({ ok: false, status, statusText: 'Bad' }),
      );
      globalThis.fetch = fetchMock;

      await expect(httpRequest('raiderio', 'https://x.test/')).rejects.toBeInstanceOf(
        HttpError,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it('HttpError carries service, status, attempts', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse({ ok: false, status: 404, statusText: 'Not Found' }),
    );

    try {
      await httpRequest('raiderio', 'https://x.test/');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      const e = err as HttpError;
      expect(e.service).toBe('raiderio');
      expect(e.status).toBe(404);
      expect(e.attempts).toBe(1);
    }
  });

  it('records failed outcome on non-retryable error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse({ ok: false, status: 404, statusText: 'Not Found' }),
    );

    await httpRequest('raiderio', 'https://x.test/').catch(() => {});
    const s = getSummary('raiderio');
    expect(s.totals.failed).toBe(1);
    expect(s.lastError?.status).toBe(404);
  });

  it('throws on JSON parse error without retry', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
    } as unknown as Response);

    await expect(httpRequest('raiderio', 'https://x.test/')).rejects.toBeInstanceOf(
      HttpError,
    );
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});

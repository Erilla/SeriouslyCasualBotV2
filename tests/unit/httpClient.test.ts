import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { __resetForTests } from '../../src/services/apiHealth.js';
import {
  httpRequest,
  HttpError,
  CircuitOpenError,
} from '../../src/services/httpClient.js';
import { getSummary, isBreakerOpen } from '../../src/services/apiHealth.js';

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

describe('httpRequest — timeout', () => {
  it('aborts the request after timeoutMs and throws HttpError', async () => {
    globalThis.fetch = vi.fn().mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            signal.addEventListener('abort', () => {
              const err = new Error('aborted');
              (err as Error & { name: string }).name = 'AbortError';
              reject(err);
            });
          }
        }),
    );

    const promise = httpRequest('raiderio', 'https://x.test/', undefined, {
      timeoutMs: 100,
      maxRetries: 0,
    }).catch((e) => e);

    await vi.advanceTimersByTimeAsync(101);
    const err = await promise;
    expect(err).toBeInstanceOf(HttpError);
  });

  it('passes caller-provided signal alongside timeout', async () => {
    const abortController = new AbortController();
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ ok: true, json: {} }));
    globalThis.fetch = fetchMock;

    await httpRequest('raiderio', 'https://x.test/', { signal: abortController.signal });

    const init = fetchMock.mock.calls[0][1] as RequestInit | undefined;
    expect(init?.signal).toBeDefined();
  });
});

describe('httpRequest — retry loop', () => {
  it.each([429, 500, 502, 503, 504])(
    'retries on %s up to maxRetries+1 attempts',
    async (status) => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({ ok: false, status, statusText: 'x' }),
      );
      globalThis.fetch = fetchMock;

      const promise = httpRequest('raiderio', 'https://x.test/').catch((e) => e);
      await vi.advanceTimersByTimeAsync(5_000);
      const err = await promise;

      expect(err).toBeInstanceOf(HttpError);
      expect(fetchMock).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
    },
  );

  it('succeeds on retry and records `retried`', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ ok: false, status: 503, statusText: 'x' }))
      .mockResolvedValueOnce(mockResponse({ ok: true, json: { ok: 1 } }));

    const promise = httpRequest<{ ok: number }>('raiderio', 'https://x.test/');
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await promise;

    expect(result).toEqual({ ok: 1 });
    const s = getSummary('raiderio');
    expect(s.totals.ok).toBe(1);
    expect(s.totals.retried).toBe(1);
  });

  it('records `rate_limited` when any attempt saw a 429 and the call ultimately fails', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse({ ok: false, status: 429, statusText: 'Too Many Requests' }),
    );

    const promise = httpRequest('raiderio', 'https://x.test/').catch((e) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    await promise;

    const s = getSummary('raiderio');
    expect(s.totals.rateLimited).toBe(1);
    expect(s.totals.failed).toBe(0);
  });

  it('records `timeout` when any attempt timed out and the call ultimately fails', async () => {
    globalThis.fetch = vi.fn().mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            (err as Error & { name: string }).name = 'AbortError';
            reject(err);
          });
        }),
    );

    const promise = httpRequest('raiderio', 'https://x.test/', undefined, {
      timeoutMs: 50,
    }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    await promise;

    const s = getSummary('raiderio');
    expect(s.totals.timeouts).toBe(1);
  });

  it('does not retry on 404', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse({ ok: false, status: 404, statusText: 'Not Found' }),
    );
    globalThis.fetch = fetchMock;

    await httpRequest('raiderio', 'https://x.test/').catch(() => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries on network throw (TypeError)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    globalThis.fetch = fetchMock;

    const promise = httpRequest('raiderio', 'https://x.test/').catch(() => {});
    await vi.advanceTimersByTimeAsync(5_000);
    await promise;

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('httpRequest — Retry-After', () => {
  it('honours Retry-After in seconds', async () => {
    const sleepStart = Date.now();
    let observedGap = 0;

    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        mockResponse({
          ok: false, status: 429, statusText: 'x',
          headers: { 'Retry-After': '5' },
        }),
      )
      .mockImplementationOnce(async () => {
        observedGap = Date.now() - sleepStart;
        return mockResponse({ ok: true, json: {} });
      });

    const promise = httpRequest('raiderio', 'https://x.test/');
    await vi.advanceTimersByTimeAsync(6_000);
    await promise;

    expect(observedGap).toBeGreaterThanOrEqual(5_000);
  });

  it('honours Retry-After as HTTP-date', async () => {
    const sleepStart = Date.now();
    const futureDate = new Date(sleepStart + 2_000).toUTCString();
    let observedGap = 0;

    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        mockResponse({
          ok: false, status: 503, statusText: 'x',
          headers: { 'Retry-After': futureDate },
        }),
      )
      .mockImplementationOnce(async () => {
        observedGap = Date.now() - sleepStart;
        return mockResponse({ ok: true, json: {} });
      });

    const promise = httpRequest('raiderio', 'https://x.test/');
    await vi.advanceTimersByTimeAsync(3_000);
    await promise;

    expect(observedGap).toBeGreaterThanOrEqual(2_000);
  });

  it('treats Retry-After > 30s as final failure without waiting', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse({
        ok: false, status: 429, statusText: 'x',
        headers: { 'Retry-After': '120' },
      }),
    );
    globalThis.fetch = fetchMock;

    const err = await httpRequest('raiderio', 'https://x.test/').catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const s = getSummary('raiderio');
    expect(s.totals.rateLimited).toBe(1);
  });
});

describe('httpRequest — circuit breaker integration', () => {
  it('opens the breaker after 5 consecutive failed calls', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse({ ok: false, status: 404, statusText: 'x' }),
    );

    for (let i = 0; i < 5; i++) {
      await httpRequest('raiderio', 'https://x.test/').catch(() => {});
    }
    expect(isBreakerOpen('raiderio')).toBe(true);
  });

  it('fast-fails with CircuitOpenError while open, without calling fetch', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse({ ok: false, status: 404, statusText: 'x' }),
    );
    for (let i = 0; i < 5; i++) {
      await httpRequest('raiderio', 'https://x.test/').catch(() => {});
    }

    const callCountBefore = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    await expect(
      httpRequest('raiderio', 'https://x.test/'),
    ).rejects.toBeInstanceOf(CircuitOpenError);

    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callCountBefore);
    expect(getSummary('raiderio').totals.circuitRejected).toBe(1);
  });

  it('half_open -> closed on a successful trial call', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse({ ok: false, status: 500, statusText: 'x' }),
    );
    const kick = async () => {
      const p = httpRequest('raiderio', 'https://x.test/').catch(() => {});
      await vi.advanceTimersByTimeAsync(5_000);
      return p;
    };
    for (let i = 0; i < 5; i++) await kick();
    expect(getSummary('raiderio').breaker).toBe('open');

    // Fast-forward past 60s cooldown.
    vi.setSystemTime(new Date(Date.now() + 61_000));
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse({ ok: true, json: {} }));

    await httpRequest('raiderio', 'https://x.test/');
    expect(getSummary('raiderio').breaker).toBe('closed');
  });
});

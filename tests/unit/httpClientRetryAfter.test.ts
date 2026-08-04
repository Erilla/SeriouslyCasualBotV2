import { describe, it, expect, afterEach, vi } from 'vitest';
import { httpRequest, HttpError } from '../../src/services/httpClient.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('HttpError.retryAfterMs', () => {
  it('carries Retry-After seconds from a 429 as milliseconds', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('slow down', { status: 429, headers: { 'Retry-After': '120' } }),
    ) as unknown as typeof fetch;

    const err = (await httpRequest('raiderio', 'https://example.test/x', {
      maxRetries: 0,
    }).catch((e: unknown) => e)) as HttpError;

    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(120_000);
  });

  it('leaves retryAfterMs undefined when the header is absent', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('nope', { status: 429 }),
    ) as unknown as typeof fetch;

    const err = (await httpRequest('raiderio', 'https://example.test/x', {
      maxRetries: 0,
    }).catch((e: unknown) => e)) as HttpError;

    expect(err.retryAfterMs).toBeUndefined();
  });
});

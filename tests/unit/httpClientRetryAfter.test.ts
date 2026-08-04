import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { httpRequest, HttpError } from '../../src/services/httpClient.js';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('HttpError.retryAfterMs', () => {
  it('carries Retry-After seconds from a 429 as milliseconds', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('slow down', { status: 429, headers: { 'Retry-After': '120' } }),
    ) as unknown as typeof fetch;

    const err = (await httpRequest('raiderio', 'https://example.test/x', undefined, {
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

    const err = (await httpRequest('raiderio', 'https://example.test/x', undefined, {
      maxRetries: 0,
    }).catch((e: unknown) => e)) as HttpError;

    expect(err.retryAfterMs).toBeUndefined();
  });

  it('leaves retryAfterMs undefined when Retry-After is 0', async () => {
    // A zero-second Retry-After parses to 0ms, but 0 must not reach the
    // error as a "real" wait: downstream `error.retryAfterMs ?? backoff`
    // fallbacks treat 0 as present and would busy-retry a rate limit.
    globalThis.fetch = vi.fn(
      async () => new Response('slow down', { status: 429, headers: { 'Retry-After': '0' } }),
    ) as unknown as typeof fetch;

    const err = (await httpRequest('raiderio', 'https://example.test/x', undefined, {
      maxRetries: 0,
    }).catch((e: unknown) => e)) as HttpError;

    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBeUndefined();
  });

  it('does not leak an earlier attempt’s Retry-After into a later, unrelated failure', async () => {
    // Attempt 1: 429 with Retry-After: 5 (retryable, so it sleeps and
    // retries). Attempt 2: 403 with no header (permanent, non-retryable).
    // The thrown error describes the 403 and must not carry the earlier
    // rate-limit signal.
    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return new Response('slow down', { status: 429, headers: { 'Retry-After': '5' } });
      }
      return new Response('forbidden', { status: 403 });
    }) as unknown as typeof fetch;

    const promise = httpRequest('raiderio', 'https://example.test/x', undefined, {
      maxRetries: 1,
    }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    const err = (await promise) as HttpError;

    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(403);
    expect(err.retryAfterMs).toBeUndefined();
  });
});

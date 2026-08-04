import { describe, it, expect } from 'vitest';
import {
  classifyError,
  backoffMs,
  shouldPreemptWclPoints,
} from '../../src/functions/applications/intel/rateLimit.js';
import { HttpError, CircuitOpenError } from '../../src/services/httpClient.js';

describe('classifyError', () => {
  it('pauses on 429 and honours Retry-After', () => {
    const err = new HttpError({
      service: 'blizzard',
      status: 429,
      attempts: 1,
      message: 'rate limited',
      retryAfterMs: 90_000,
    });
    expect(classifyError(err, 1)).toEqual({
      pause: true,
      service: 'blizzard',
      resumeAfterMs: 90_000,
    });
  });

  it('pauses on 429 without Retry-After using the backoff schedule', () => {
    const err = new HttpError({
      service: 'warcraftlogs',
      status: 429,
      attempts: 1,
      message: 'rate limited',
    });
    expect(classifyError(err, 1)).toEqual({
      pause: true,
      service: 'warcraftlogs',
      resumeAfterMs: backoffMs(1),
    });
  });

  it('pauses on an open circuit', () => {
    expect(classifyError(new CircuitOpenError('raiderio'), 2)).toEqual({
      pause: true,
      service: 'raiderio',
      resumeAfterMs: backoffMs(2),
    });
  });

  it('does not pause on a 404', () => {
    const err = new HttpError({
      service: 'raiderio',
      status: 404,
      attempts: 1,
      message: 'not found',
    });
    expect(classifyError(err, 1)).toEqual({ pause: false });
  });

  it('does not pause on a non-HTTP error', () => {
    expect(classifyError(new Error('boom'), 1)).toEqual({ pause: false });
  });
});

describe('backoffMs', () => {
  it('escalates 5min, 15min, 60min and caps at an hour', () => {
    expect(backoffMs(1)).toBe(5 * 60_000);
    expect(backoffMs(2)).toBe(15 * 60_000);
    expect(backoffMs(3)).toBe(60 * 60_000);
    expect(backoffMs(9)).toBe(60 * 60_000);
  });

  it('treats a zeroth attempt as the first step', () => {
    expect(backoffMs(0)).toBe(5 * 60_000);
  });
});

describe('shouldPreemptWclPoints', () => {
  it('pre-empts at or above 90% of the hourly budget', () => {
    expect(shouldPreemptWclPoints(8100, 9000)).toBe(true);
    expect(shouldPreemptWclPoints(8999, 9000)).toBe(true);
  });

  it('does not pre-empt below 90%', () => {
    expect(shouldPreemptWclPoints(4000, 9000)).toBe(false);
  });

  it('does not pre-empt when the limit is unknown', () => {
    expect(shouldPreemptWclPoints(4000, 0)).toBe(false);
  });
});

describe('classifyError — mixed rate-limit storms', () => {
  /**
   * httpRequest's retry-exhaustion path throws with the LAST status it saw, so a
   * run that was 429'd on early attempts and got a 503 on the final one surfaces
   * as status 503. Keying only on 429 let that degrade-and-finish, publishing
   * partial results for a job that really was rate-limited.
   */
  it('pauses when a non-429 status still carries a rate-limit wait', () => {
    const err = new HttpError({
      service: 'blizzard',
      status: 503,
      attempts: 3,
      message: 'service unavailable',
      retryAfterMs: 45_000,
    });
    expect(classifyError(err, 1)).toEqual({
      pause: true,
      service: 'blizzard',
      resumeAfterMs: 45_000,
    });
  });

  it('still does not pause on a plain 5xx with no rate-limit signal', () => {
    const err = new HttpError({
      service: 'blizzard',
      status: 503,
      attempts: 3,
      message: 'service unavailable',
    });
    expect(classifyError(err, 1)).toEqual({ pause: false });
  });
});

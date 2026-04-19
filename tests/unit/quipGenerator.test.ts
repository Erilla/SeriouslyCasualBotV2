import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateSignupQuip } from '../../src/services/quipGenerator.js';

const originalFetch = globalThis.fetch;
const originalApiKey = process.env.GEMINI_API_KEY;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalApiKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = originalApiKey;
  vi.restoreAllMocks();
});

describe('generateSignupQuip', () => {
  it('falls back to a static quip when GEMINI_API_KEY is not set', async () => {
    delete process.env.GEMINI_API_KEY;

    const quip = await generateSignupQuip({ raidDay: 'Wednesday', twoDayReminder: false });
    expect(typeof quip).toBe('string');
    expect(quip.length).toBeGreaterThan(0);
  });

  it('returns the Gemini response when the API call succeeds', async () => {
    process.env.GEMINI_API_KEY = 'test-key';

    globalThis.fetch = vi.fn(async () => {
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: 'Stop standing in fire — sign up!' }] } }],
        }),
        text: async () => '',
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const quip = await generateSignupQuip({ raidDay: 'Sunday', twoDayReminder: true });
    expect(quip).toBe('Stop standing in fire — sign up!');
  });

  it('strips surrounding quotes from the Gemini response', async () => {
    process.env.GEMINI_API_KEY = 'test-key';

    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '"Sign up or face the wrath of Warzania!"' }] } }],
      }),
      text: async () => '',
    })) as unknown as typeof fetch;

    const quip = await generateSignupQuip({ raidDay: 'Wednesday', twoDayReminder: false });
    expect(quip).toBe('Sign up or face the wrath of Warzania!');
  });

  it('strips surrounding smart (curly) quotes', async () => {
    // Gemini often returns \u201Ctext\u201D instead of plain "text"; the
    // normalizer needs to cover both shapes.
    process.env.GEMINI_API_KEY = 'test-key';

    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: { parts: [{ text: '\u201CRaid sign-ups: late doesn\u2019t count.\u201D' }] },
          },
        ],
      }),
      text: async () => '',
    })) as unknown as typeof fetch;

    const quip = await generateSignupQuip({ raidDay: 'Wednesday', twoDayReminder: false });
    expect(quip).toBe('Raid sign-ups: late doesn\u2019t count.');
  });

  it('takes only the first line when Gemini returns a numbered list', async () => {
    process.env.GEMINI_API_KEY = 'test-key';

    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [{ text: '1. Sign up, you slackers!\n2. Or face Warzania\'s wrath.' }],
            },
          },
        ],
      }),
      text: async () => '',
    })) as unknown as typeof fetch;

    const quip = await generateSignupQuip({ raidDay: 'Sunday', twoDayReminder: false });
    expect(quip).toBe('Sign up, you slackers!');
  });

  it('falls back when Gemini returns HTTP error', async () => {
    process.env.GEMINI_API_KEY = 'test-key';

    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 429,
      json: async () => ({}),
      text: async () => 'Rate limited',
    })) as unknown as typeof fetch;

    const quip = await generateSignupQuip({ raidDay: 'Wednesday', twoDayReminder: false });
    expect(typeof quip).toBe('string');
    expect(quip.length).toBeGreaterThan(0);
  });

  it('falls back when Gemini returns error in body', async () => {
    process.env.GEMINI_API_KEY = 'test-key';

    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ error: { message: 'Invalid API key' } }),
      text: async () => '',
    })) as unknown as typeof fetch;

    const quip = await generateSignupQuip({ raidDay: 'Wednesday', twoDayReminder: false });
    expect(typeof quip).toBe('string');
    expect(quip.length).toBeGreaterThan(0);
  });

  it('falls back when Gemini returns an over-long response (format failure)', async () => {
    process.env.GEMINI_API_KEY = 'test-key';

    const megaQuip = 'x'.repeat(500);
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: megaQuip }] } }] }),
      text: async () => '',
    })) as unknown as typeof fetch;

    const quip = await generateSignupQuip({ raidDay: 'Wednesday', twoDayReminder: false });
    expect(quip.length).toBeLessThanOrEqual(280);
  });

  it('falls back when candidate has no parts array (SAFETY / MAX_TOKENS)', async () => {
    // Gemini sometimes returns a candidate without a parts array — e.g. when
    // the response hits a safety filter or MAX_TOKENS before producing text.
    // Previously parts?.map(...).join('') crashed with TypeError.
    process.env.GEMINI_API_KEY = 'test-key';

    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        candidates: [{ finishReason: 'SAFETY', content: {} }],
      }),
      text: async () => '',
    })) as unknown as typeof fetch;

    const quip = await generateSignupQuip({ raidDay: 'Wednesday', twoDayReminder: false });
    expect(typeof quip).toBe('string');
    expect(quip.length).toBeGreaterThan(0);
  });

  it('falls back when fetch throws (network failure)', async () => {
    process.env.GEMINI_API_KEY = 'test-key';

    globalThis.fetch = vi.fn(async () => {
      throw new Error('ENETUNREACH');
    }) as unknown as typeof fetch;

    const quip = await generateSignupQuip({ raidDay: 'Wednesday', twoDayReminder: false });
    expect(typeof quip).toBe('string');
    expect(quip.length).toBeGreaterThan(0);
  });
});

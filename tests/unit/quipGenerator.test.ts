import { describe, it, expect, afterEach, vi } from 'vitest';
import { generateSignupQuip } from '../../src/services/quipGenerator.js';

const originalFetch = globalThis.fetch;
const originalApiKey = process.env.GEMINI_API_KEY;
const originalOpenAIKey = process.env.OPENAI_API_KEY;
const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalApiKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = originalApiKey;
  if (originalOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenAIKey;
  if (originalAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
  vi.restoreAllMocks();
});

describe('generateSignupQuip', () => {
  it('falls back to a static quip when GEMINI_API_KEY is not set', async () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

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

  it('calls Gemini via the flash-lite-latest alias (pinned models get retired)', async () => {
    process.env.GEMINI_API_KEY = 'test-key';

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'Sign up!' }] } }],
      }),
      text: async () => '',
    })) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    await generateSignupQuip({ raidDay: 'Sunday', twoDayReminder: false });

    const url = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain('/models/gemini-flash-lite-latest:generateContent');
  });

  it('strips surrounding quotes from the Gemini response', async () => {
    process.env.GEMINI_API_KEY = 'test-key';

    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        candidates: [
          { content: { parts: [{ text: '"Sign up or face the wrath of Warzania!"' }] } },
        ],
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
              parts: [{ text: "1. Sign up, you slackers!\n2. Or face Warzania's wrath." }],
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

  it('includes Overlord names in the prompt when provided', async () => {
    process.env.GEMINI_API_KEY = 'test-key';

    let capturedBody = '';
    globalThis.fetch = vi.fn(async (_url: string, init: RequestInit) => {
      capturedBody = String(init.body);
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: 'Sign up!' }] } }],
        }),
        text: async () => '',
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await generateSignupQuip({
      raidDay: 'Wednesday',
      twoDayReminder: false,
      overlordNames: ['Gandalf', 'Saruman'],
    });

    expect(capturedBody).toContain('Gandalf, Saruman');
    expect(capturedBody).toContain('Overlords');
  });

  it('omits the leader-name clause when no Overlords are provided', async () => {
    process.env.GEMINI_API_KEY = 'test-key';

    let capturedBody = '';
    globalThis.fetch = vi.fn(async (_url: string, init: RequestInit) => {
      capturedBody = String(init.body);
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: 'Sign up!' }] } }],
        }),
        text: async () => '',
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await generateSignupQuip({ raidDay: 'Wednesday', twoDayReminder: false });

    expect(capturedBody).not.toContain('Overlords');
  });

  it('uses OpenAI when Gemini fails', async () => {
    process.env.GEMINI_API_KEY = 'gemini-key';
    process.env.OPENAI_API_KEY = 'openai-key';
    delete process.env.ANTHROPIC_API_KEY;

    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes('generativelanguage.googleapis.com')) {
        return {
          ok: false,
          status: 500,
          json: async () => ({}),
          text: async () => 'boom',
        } as unknown as Response;
      }
      if (url.includes('api.openai.com')) {
        return {
          ok: true,
          json: async () => ({ choices: [{ message: { content: 'OpenAI says sign up!' } }] }),
          text: async () => '',
        } as unknown as Response;
      }
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;

    const quip = await generateSignupQuip({ raidDay: 'Wednesday', twoDayReminder: false });
    expect(quip).toBe('OpenAI says sign up!');
  });

  it('skips OpenAI when its key is unset and falls back to static', async () => {
    process.env.GEMINI_API_KEY = 'gemini-key';
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes('api.openai.com')) throw new Error('OpenAI should not be called');
      return {
        ok: false,
        status: 500,
        json: async () => ({}),
        text: async () => 'boom',
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const quip = await generateSignupQuip({ raidDay: 'Wednesday', twoDayReminder: false });
    expect(typeof quip).toBe('string');
    expect(quip.length).toBeGreaterThan(0);
  });

  it('uses Claude when Gemini and OpenAI both fail', async () => {
    process.env.GEMINI_API_KEY = 'gemini-key';
    process.env.OPENAI_API_KEY = 'openai-key';
    process.env.ANTHROPIC_API_KEY = 'anthropic-key';

    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes('api.anthropic.com')) {
        return {
          ok: true,
          json: async () => ({ content: [{ type: 'text', text: 'Claude says sign up!' }] }),
          text: async () => '',
        } as unknown as Response;
      }
      // Gemini + OpenAI both error
      return {
        ok: false,
        status: 500,
        json: async () => ({}),
        text: async () => 'boom',
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const quip = await generateSignupQuip({ raidDay: 'Sunday', twoDayReminder: true });
    expect(quip).toBe('Claude says sign up!');
  });

  it('falls back to a static quip when all three providers fail', async () => {
    process.env.GEMINI_API_KEY = 'gemini-key';
    process.env.OPENAI_API_KEY = 'openai-key';
    process.env.ANTHROPIC_API_KEY = 'anthropic-key';

    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => 'boom',
    })) as unknown as typeof fetch;

    const quip = await generateSignupQuip({ raidDay: 'Wednesday', twoDayReminder: false });
    expect(typeof quip).toBe('string');
    expect(quip.length).toBeGreaterThan(0);
  });
});

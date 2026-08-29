import { describe, it, expect, afterEach, vi } from 'vitest';
import { generateSignupQuip } from '../../src/services/quipGenerator.js';
import { logger } from '../../src/services/logger.js';

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

const GEMINI_FIRST = new Date('2026-01-03T12:00:00Z');
const OPENAI_FIRST = new Date('2026-01-04T12:00:00Z');
const CLAUDE_FIRST = new Date('2026-01-05T12:00:00Z');

function mockAllProvidersOk(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string) => ({
    ok: true,
    json: async () => {
      if (url.includes('generativelanguage.googleapis.com')) {
        return { candidates: [{ content: { parts: [{ text: 'gemini quip' }] } }] };
      }
      if (url.includes('api.openai.com')) {
        return { choices: [{ message: { content: 'openai quip' } }] };
      }
      return { content: [{ type: 'text', text: 'claude quip' }] };
    },
    text: async () => '',
  }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function setAllKeys(): void {
  process.env.GEMINI_API_KEY = 'g-key';
  process.env.OPENAI_API_KEY = 'o-key';
  process.env.ANTHROPIC_API_KEY = 'a-key';
}

async function capturePrompt(options: Parameters<typeof generateSignupQuip>[0]): Promise<string> {
  process.env.GEMINI_API_KEY = 'test-key';
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ candidates: [{ content: { parts: [{ text: 'Sign up!' }] } }] }),
    text: async () => '',
  })) as unknown as typeof fetch;
  globalThis.fetch = fetchMock;

  await generateSignupQuip({ ...options, now: GEMINI_FIRST });
  const body = JSON.parse((fetchMock as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string);
  return body.contents[0].parts[0].text as string;
}

describe('generateSignupQuip', () => {
  it('rotates the starting provider by day of year', async () => {
    setAllKeys();
    mockAllProvidersOk();
    expect(
      (await generateSignupQuip({ raidDay: 'Sunday', twoDayReminder: false, now: GEMINI_FIRST }))
        .quip,
    ).toBe('gemini quip');
    expect(
      (await generateSignupQuip({ raidDay: 'Sunday', twoDayReminder: false, now: OPENAI_FIRST }))
        .quip,
    ).toBe('openai quip');
    expect(
      (await generateSignupQuip({ raidDay: 'Sunday', twoDayReminder: false, now: CLAUDE_FIRST }))
        .quip,
    ).toBe('claude quip');
  });

  it('falls through in rotated order when the first provider fails', async () => {
    setAllKeys();
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('api.anthropic.com')) {
        return { ok: false, status: 500, json: async () => ({}), text: async () => 'boom' };
      }
      return {
        ok: true,
        json: async () => ({ candidates: [{ content: { parts: [{ text: 'gemini quip' }] } }] }),
        text: async () => '',
      };
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // Claude-first day: Claude fails, Gemini (next in rotation) wins.
    const result = await generateSignupQuip({
      raidDay: 'Sunday',
      twoDayReminder: false,
      now: CLAUDE_FIRST,
    });
    expect(result.quip).toBe('gemini quip');
    expect(fetchMock.mock.calls[0][0] as string).toContain('api.anthropic.com');
  });

  it('marks static-corpus fallback with generated: false', async () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    const result = await generateSignupQuip({ raidDay: 'Wednesday', twoDayReminder: false });
    expect(result.generated).toBe(false);
    expect(result.quip.length).toBeGreaterThan(0);
  });

  it('marks LLM quips with generated: true', async () => {
    process.env.GEMINI_API_KEY = 'test-key';

    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'Sign up!' }] } }],
      }),
      text: async () => '',
    })) as unknown as typeof fetch;

    const result = await generateSignupQuip({ raidDay: 'Sunday', twoDayReminder: false });
    expect(result.generated).toBe(true);
    expect(result.quip).toBe('Sign up!');
  });

  it('falls back to a static quip when GEMINI_API_KEY is not set', async () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    const result = await generateSignupQuip({ raidDay: 'Wednesday', twoDayReminder: false });
    expect(typeof result.quip).toBe('string');
    expect(result.quip.length).toBeGreaterThan(0);
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

    const result = await generateSignupQuip({
      raidDay: 'Sunday',
      twoDayReminder: true,
      now: GEMINI_FIRST,
    });
    expect(result.quip).toBe('Stop standing in fire — sign up!');
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

    await generateSignupQuip({ raidDay: 'Sunday', twoDayReminder: false, now: GEMINI_FIRST });

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

    const result = await generateSignupQuip({
      raidDay: 'Wednesday',
      twoDayReminder: false,
      now: GEMINI_FIRST,
    });
    expect(result.quip).toBe('Sign up or face the wrath of Warzania!');
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

    const result = await generateSignupQuip({
      raidDay: 'Wednesday',
      twoDayReminder: false,
      now: GEMINI_FIRST,
    });
    expect(result.quip).toBe('Raid sign-ups: late doesn\u2019t count.');
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

    const result = await generateSignupQuip({
      raidDay: 'Sunday',
      twoDayReminder: false,
      now: GEMINI_FIRST,
    });
    expect(result.quip).toBe('Sign up, you slackers!');
  });

  it('falls back when Gemini returns HTTP error', async () => {
    process.env.GEMINI_API_KEY = 'test-key';

    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 429,
      json: async () => ({}),
      text: async () => 'Rate limited',
    })) as unknown as typeof fetch;

    const result = await generateSignupQuip({ raidDay: 'Wednesday', twoDayReminder: false });
    expect(typeof result.quip).toBe('string');
    expect(result.quip.length).toBeGreaterThan(0);
  });

  it('falls back when Gemini returns error in body', async () => {
    process.env.GEMINI_API_KEY = 'test-key';

    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ error: { message: 'Invalid API key' } }),
      text: async () => '',
    })) as unknown as typeof fetch;

    const result = await generateSignupQuip({ raidDay: 'Wednesday', twoDayReminder: false });
    expect(typeof result.quip).toBe('string');
    expect(result.quip.length).toBeGreaterThan(0);
  });

  it('falls back when Gemini returns an over-long response (format failure)', async () => {
    process.env.GEMINI_API_KEY = 'test-key';

    const megaQuip = 'x'.repeat(500);
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: megaQuip }] } }] }),
      text: async () => '',
    })) as unknown as typeof fetch;

    const result = await generateSignupQuip({
      raidDay: 'Wednesday',
      twoDayReminder: false,
      now: GEMINI_FIRST,
    });
    expect(result.quip.length).toBeLessThanOrEqual(280);
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

    const result = await generateSignupQuip({ raidDay: 'Wednesday', twoDayReminder: false });
    expect(typeof result.quip).toBe('string');
    expect(result.quip.length).toBeGreaterThan(0);
  });

  it('falls back when fetch throws (network failure)', async () => {
    process.env.GEMINI_API_KEY = 'test-key';

    globalThis.fetch = vi.fn(async () => {
      throw new Error('ENETUNREACH');
    }) as unknown as typeof fetch;

    const result = await generateSignupQuip({ raidDay: 'Wednesday', twoDayReminder: false });
    expect(typeof result.quip).toBe('string');
    expect(result.quip.length).toBeGreaterThan(0);
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

    const result = await generateSignupQuip({
      raidDay: 'Wednesday',
      twoDayReminder: false,
      now: GEMINI_FIRST,
    });
    expect(result.quip).toBe('OpenAI says sign up!');
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

    const result = await generateSignupQuip({
      raidDay: 'Wednesday',
      twoDayReminder: false,
      now: GEMINI_FIRST,
    });
    expect(typeof result.quip).toBe('string');
    expect(result.quip.length).toBeGreaterThan(0);
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

    const result = await generateSignupQuip({
      raidDay: 'Sunday',
      twoDayReminder: true,
      now: GEMINI_FIRST,
    });
    expect(result.quip).toBe('Claude says sign up!');
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

    const result = await generateSignupQuip({ raidDay: 'Wednesday', twoDayReminder: false });
    expect(typeof result.quip).toBe('string');
    expect(result.quip.length).toBeGreaterThan(0);
  });

  it('logs the resolved model name at info on success', async () => {
    setAllKeys();
    const infoSpy = vi.spyOn(logger, 'info');
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'Sign up!' }] } }],
        modelVersion: 'gemini-3.1-flash-lite',
      }),
      text: async () => '',
    })) as unknown as typeof fetch;

    await generateSignupQuip({ raidDay: 'Sunday', twoDayReminder: false, now: GEMINI_FIRST });
    expect(infoSpy).toHaveBeenCalledWith(
      'QuipGen',
      'Quip generated via Gemini (gemini-3.1-flash-lite)',
    );
  });

  it('logs the static fallback at info', async () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const infoSpy = vi.spyOn(logger, 'info');

    await generateSignupQuip({ raidDay: 'Sunday', twoDayReminder: false });
    expect(infoSpy).toHaveBeenCalledWith('QuipGen', 'Quip fallback: static V1 corpus');
  });

  it('always includes a persona, meme licence, and restraint rule in the prompt', async () => {
    const prompt = await capturePrompt({ raidDay: 'Sunday', twoDayReminder: false });
    expect(prompt).toContain('Write in the voice of a ');
    expect(prompt).toContain('classic WoW meme');
    expect(prompt).toContain('at most one or two');
  });

  it('includes the unsigned count when provided', async () => {
    const prompt = await capturePrompt({
      raidDay: 'Sunday',
      twoDayReminder: false,
      unsignedCount: 6,
    });
    expect(prompt).toContain("6 raiders still haven't signed up");
  });

  it('frames the quip as a celebration when everyone has signed up', async () => {
    const prompt = await capturePrompt({
      raidDay: 'Sunday',
      twoDayReminder: false,
      allSignedUp: true,
    });

    expect(prompt).toContain('Every raider has signed up — celebrate the completed roster.');
    expect(prompt).not.toContain('get their raiders to sign up');
  });

  it('includes progression context in progress mode', async () => {
    const prompt = await capturePrompt({
      raidDay: 'Sunday',
      twoDayReminder: false,
      progression: {
        mode: 'progress',
        raidName: 'Current Raid',
        bossName: 'The End Boss',
        killed: 2,
        total: 3,
      },
    });
    expect(prompt).toContain('currently progressing The End Boss in Current Raid (2/3M)');
  });

  it('includes reclear context when the end boss is dead', async () => {
    const prompt = await capturePrompt({
      raidDay: 'Sunday',
      twoDayReminder: false,
      progression: {
        mode: 'reclear',
        raidName: 'Current Raid',
        bossName: 'The End Boss',
        killed: 3,
        total: 3,
      },
    });
    expect(prompt).toContain('Current Raid on farm');
    expect(prompt).toContain('The End Boss is dead');
  });

  it('omits progression and count lines when not provided', async () => {
    const prompt = await capturePrompt({
      raidDay: 'Sunday',
      twoDayReminder: false,
      progression: null,
    });
    expect(prompt).not.toContain('progressing');
    expect(prompt).not.toContain('on farm');
    expect(prompt).not.toContain("still haven't signed up");
  });

  it('lists recent quips with an instruction not to repeat them', async () => {
    const prompt = await capturePrompt({
      raidDay: 'Sunday',
      twoDayReminder: false,
      recentQuips: ['Old quip one', 'Old quip two'],
    });
    expect(prompt).toContain('clearly different');
    expect(prompt).toContain('Old quip one');
    expect(prompt).toContain('Old quip two');
  });

  it('grounds Gemini with the google_search tool', async () => {
    setAllKeys();
    const fetchMock = mockAllProvidersOk();
    await generateSignupQuip({ raidDay: 'Sunday', twoDayReminder: false, now: GEMINI_FIRST });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.tools).toEqual([{ google_search: {} }]);
  });

  it('grounds OpenAI with the current Chat Completions search model and web_search_options', async () => {
    setAllKeys();
    const fetchMock = mockAllProvidersOk();
    await generateSignupQuip({ raidDay: 'Sunday', twoDayReminder: false, now: OPENAI_FIRST });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.model).toBe('gpt-5-search-api');
    expect(body.web_search_options).toEqual({ search_context_size: 'low' });
    expect(body.temperature).toBeUndefined();
  });

  it('grounds Claude with the web_search server tool capped at one search', async () => {
    setAllKeys();
    const fetchMock = mockAllProvidersOk();
    await generateSignupQuip({ raidDay: 'Sunday', twoDayReminder: false, now: CLAUDE_FIRST });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.tools).toEqual([{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }]);
  });

  it('ignores non-text blocks (search results, citations) in the Claude response', async () => {
    setAllKeys();
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        content: [
          {
            type: 'server_tool_use',
            id: 'srvtoolu_1',
            name: 'web_search',
            input: { query: 'trending meme' },
          },
          { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [] },
          { type: 'text', text: 'Grounded quip!' },
        ],
      }),
      text: async () => '',
    })) as unknown as typeof fetch;

    const result = await generateSignupQuip({
      raidDay: 'Sunday',
      twoDayReminder: false,
      now: CLAUDE_FIRST,
    });
    expect(result.quip).toBe('Grounded quip!');
  });
});

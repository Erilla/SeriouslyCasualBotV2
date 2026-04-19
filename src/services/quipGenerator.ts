import { logger } from './logger.js';

// V1 quip corpus — handwritten + OpenAI-generated examples that shaped the
// tone. Kept in-file so fallback still feels like "our" quips when the API
// is down or the key isn't set. Anything appended here shows up in the
// fallback pool and as few-shot inspiration in the Gemini prompt.
const V1_SAMPLE_QUIPS: readonly string[] = [
  "Oi, sign up innit?",
  "Have you considered signing up on time?",
  "Missing raid sign-ups is like going into battle without armor. Suit up and sign up!",
  "Don't be the ghost of raiding past — haunt the sign-up sheet instead!",
  "Raid sign-ups: where the only thing better than your DPS is your punctuality!",
  "Bing's checklist: snacks, buffs, and raid sign-ups. Don't make him hunt you down for the last one!",
  "Warzania's decree: Thou shalt sign up for the raid or face the wrath of a thousand guildies!",
];

const FALLBACK_QUIP = 'Sign up for the next raid!';

// Rough upper bound on a quip. Gemini sometimes rambles if left unbounded;
// anything longer than this is almost certainly a format failure (e.g. the
// model returned multiple options separated by newlines) and we bail to
// fallback rather than post a paragraph.
const MAX_QUIP_LENGTH = 280;

const GEMINI_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

// Don't block the signup alert on a slow model. The cron fires at a fixed
// time of day; a 5s timeout keeps the alert near-real-time and still gives
// the free tier plenty of headroom (typical latency is <2s).
const REQUEST_TIMEOUT_MS = 5_000;

// ─── Public ─────────────────────────────────────────────────────────────

export interface GenerateQuipOptions {
  raidDay: string;
  twoDayReminder: boolean;
}

/**
 * Generate a one-line signup quip. Uses Google's free-tier Gemini 2.0 Flash
 * when GEMINI_API_KEY is set, and falls back to a handwritten quip from the
 * V1 corpus when the key is missing or the call fails. Never throws — the
 * caller is an alert handler and should always get something postable.
 *
 * Fallback path is deterministic w.r.t. Math.random so we don't repeat the
 * same fallback two alerts in a row (in practice, random is enough).
 */
export async function generateSignupQuip(options: GenerateQuipOptions): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return randomFallback();
  }

  try {
    const quip = await callGemini(apiKey, options);
    if (quip) return quip;
  } catch (err) {
    logger.warn(
      'QuipGen',
      `Gemini call failed, falling back to static quip: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return randomFallback();
}

// ─── Internals ──────────────────────────────────────────────────────────

function randomFallback(): string {
  if (V1_SAMPLE_QUIPS.length === 0) return FALLBACK_QUIP;
  const index = Math.floor(Math.random() * V1_SAMPLE_QUIPS.length);
  return V1_SAMPLE_QUIPS[index];
}

function buildPrompt({ raidDay, twoDayReminder }: GenerateQuipOptions): string {
  const examples = V1_SAMPLE_QUIPS.map((q, i) => `${i + 1}. ${q}`).join('\n');
  const reminderNote = twoDayReminder
    ? 'This is the 48-hour early reminder, so a nudge-not-yell tone.'
    : 'This is the day-of reminder, so urgency is fair game.';

  return [
    'You write one-line nudges that a World of Warcraft raiding guild uses to get their raiders to sign up for the next raid.',
    '',
    `Context: the next raid is on ${raidDay}. ${reminderNote}`,
    '',
    'Tone: playful, sarcastic, WoW-themed. Occasionally reference guild leaders (Warzania, Bing, Splo). OK to be cheeky; keep it safe for a shared Discord channel.',
    '',
    'Examples of the tone:',
    examples,
    '',
    'Write ONE quip. Plain text, no quotes, no preamble, no markdown. Under 200 characters. Just the quip.',
  ].join('\n');
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  error?: { message?: string };
}

async function callGemini(
  apiKey: string,
  options: GenerateQuipOptions,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    // Send the key in the x-goog-api-key header rather than as a query
    // param. Query params are routinely captured in server access logs and
    // client-side network panels, and a leaked key on the free tier still
    // maps to an identifiable Google account.
    const response = await fetch(GEMINI_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: buildPrompt(options) }] }],
        generationConfig: {
          temperature: 0.9,
          topP: 0.95,
          maxOutputTokens: 120,
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Gemini HTTP ${response.status}: ${body.slice(0, 200)}`);
    }

    const json = (await response.json()) as GeminiResponse;
    if (json.error?.message) {
      throw new Error(`Gemini API error: ${json.error.message}`);
    }

    const candidate = json.candidates?.[0];
    const text = candidate?.content?.parts?.map((p) => p.text ?? '').join('').trim();
    if (!text) {
      logger.warn('QuipGen', `Gemini returned no text (finishReason: ${candidate?.finishReason ?? 'unknown'})`);
      return null;
    }

    const cleaned = normalizeQuip(text);
    if (cleaned.length === 0 || cleaned.length > MAX_QUIP_LENGTH) {
      logger.warn('QuipGen', `Gemini quip rejected (length ${cleaned.length}): ${cleaned.slice(0, 80)}`);
      return null;
    }
    return cleaned;
  } finally {
    clearTimeout(timer);
  }
}

// Gemini sometimes wraps its answer in quotes, returns a numbered list
// with multiple options, or prefaces with "Here's one:". Strip the obvious
// junk. If anything weird remains we'll fall through to the length guard.
function normalizeQuip(raw: string): string {
  // Take the first non-empty line without materializing the rest.
  const firstLine = raw.split(/\r?\n/).find((l) => l.trim().length > 0);
  let s = (firstLine ?? raw).trim();

  // Drop "1. " / "- " / "* " list prefixes.
  s = s.replace(/^(?:\d+\.\s+|-\s+|\*\s+)/, '');

  // Drop surrounding single or double quotes.
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith('\'') && s.endsWith('\''))) {
    s = s.slice(1, -1).trim();
  }

  return s;
}

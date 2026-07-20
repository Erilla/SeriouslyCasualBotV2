import type { ProgressionContext } from './quipContext.js';
import { logger } from './logger.js';
import { config } from '../config.js';

// V1 quip corpus — handwritten + OpenAI-generated examples that shaped the
// tone. Kept in-file so fallback still feels like "our" quips when the API
// is down or the key isn't set. Anything appended here shows up in the
// fallback pool and as few-shot inspiration in the Gemini prompt.
const V1_SAMPLE_QUIPS: readonly string[] = [
  'Oi, sign up innit?',
  'Have you considered signing up on time?',
  'Missing raid sign-ups is like going into battle without armor. Suit up and sign up!',
  "Don't be the ghost of raiding past — haunt the sign-up sheet instead!",
  'Raid sign-ups: where the only thing better than your DPS is your punctuality!',
  "Bing's checklist: snacks, buffs, and raid sign-ups. Don't make him hunt you down for the last one!",
  "Warzania's decree: Thou shalt sign up for the raid or face the wrath of a thousand guildies!",
];

// One is picked at random per alert for variety. Personas are flavour only —
// the restraint rule in the prompt stops the model stacking every element.
const PERSONAS: readonly string[] = [
  'drill sergeant',
  'disappointed parent',
  'greedy loot goblin',
  'condescending gnome engineer',
  'doomsaying shadow priest',
  'overly cheerful holy priest',
  'guild bank goblin accountant',
  'melodramatic bard',
];

// Rough upper bound on a quip. Gemini sometimes rambles if left unbounded;
// anything longer than this is almost certainly a format failure (e.g. the
// model returned multiple options separated by newlines) and we bail to
// fallback rather than post a paragraph.
const MAX_QUIP_LENGTH = 280;

// The `-latest` alias tracks the current cheapest flash model. We pin an
// alias rather than a version because Google retires pinned models
// (gemini-2.0-flash started 404ing in July 2026) and a dead model silently
// drops us to the next provider on every call.
const GEMINI_MODEL = 'gemini-flash-lite-latest';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// Don't block the signup alert on a slow model. The cron fires at a fixed
// time of day; a 5s timeout keeps the alert near-real-time and still gives
// the free tier plenty of headroom (typical latency is <2s).
const REQUEST_TIMEOUT_MS = 5_000;

// ─── Public ─────────────────────────────────────────────────────────────

export interface GenerateQuipOptions {
  raidDay: string;
  twoDayReminder: boolean;
  /** Names of the guild's Overlords to optionally reference. Empty = no name reference. */
  overlordNames?: string[];
  /** How many raiders haven't signed up yet. Omitted = no count line. */
  unsignedCount?: number;
  /** Current Mythic progression, or null/omitted to skip the line. */
  progression?: ProgressionContext | null;
  /** Recent quips the model should avoid resembling. */
  recentQuips?: string[];
  /** Clock override so tests can pin the provider rotation. */
  now?: Date;
}

export interface QuipResult {
  quip: string;
  generated: boolean;
}

interface ProviderResult {
  text: string | null;
  /** Model the API says actually served the request; null if not echoed. */
  resolvedModel: string | null;
}

interface QuipProvider {
  name: string;
  model: string;
  getKey: () => string;
  call: (apiKey: string, prompt: string) => Promise<ProviderResult>;
}

// Model constants for PROVIDERS initialization
const OPENAI_MODEL = 'gpt-4o-mini';
const ANTHROPIC_MODEL = 'claude-haiku-4-5';
const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';

const PROVIDERS: QuipProvider[] = [
  { name: 'Gemini', model: GEMINI_MODEL, getKey: () => config.geminiApiKey, call: callGemini },
  { name: 'OpenAI', model: OPENAI_MODEL, getKey: () => config.openaiApiKey, call: callOpenAI },
  { name: 'Claude', model: ANTHROPIC_MODEL, getKey: () => config.anthropicApiKey, call: callClaude },
];

// Rotate the starting provider daily so the guild hears all three model
// voices. Derived from the date (not a counter) because every deploy
// restarts the bot, which would reset a counter back to Gemini.
function dayOfYear(date: Date): number {
  const startOfYear = Date.UTC(date.getUTCFullYear(), 0, 0);
  return Math.floor((date.getTime() - startOfYear) / 86_400_000);
}

function rotatedProviders(date: Date): QuipProvider[] {
  const offset = dayOfYear(date) % PROVIDERS.length;
  return [...PROVIDERS.slice(offset), ...PROVIDERS.slice(0, offset)];
}

/**
 * Generate a one-line signup quip. Tries each provider starting from a
 * daily-rotated offset into `PROVIDERS` (so Gemini, OpenAI, and Claude each
 * take turns going first), wrapping around and skipping any whose API key
 * isn't set, and falls back to a randomly-chosen quip from the V1 corpus
 * when every provider is skipped or fails. Never throws — the caller is an
 * alert handler and should always get something postable.
 */
export async function generateSignupQuip(options: GenerateQuipOptions): Promise<QuipResult> {
  const prompt = buildPrompt(options);
  const providers = rotatedProviders(options.now ?? new Date());

  for (const provider of providers) {
    const apiKey = provider.getKey();
    if (!apiKey) continue;

    try {
      const result = await provider.call(apiKey, prompt);
      if (!result.text) continue;

      const cleaned = normalizeQuip(result.text);
      if (cleaned.length === 0 || cleaned.length > MAX_QUIP_LENGTH) {
        logger.warn(
          'QuipGen',
          `${provider.name} quip rejected (length ${cleaned.length}): ${cleaned.slice(0, 80)}`,
        );
        continue;
      }

      logger.info('QuipGen', `Quip generated via ${provider.name} (${result.resolvedModel ?? provider.model})`);
      return { quip: cleaned, generated: true };
    } catch (err) {
      logger.warn(
        'QuipGen',
        `${provider.name} call failed, trying next provider: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  logger.info('QuipGen', 'Quip fallback: static V1 corpus');
  return { quip: randomFallback(), generated: false };
}

// ─── Internals ──────────────────────────────────────────────────────────

function randomFallback(): string {
  const index = Math.floor(Math.random() * V1_SAMPLE_QUIPS.length);
  return V1_SAMPLE_QUIPS[index];
}

function buildPrompt({
  raidDay,
  twoDayReminder,
  overlordNames = [],
  unsignedCount,
  progression,
  recentQuips = [],
}: GenerateQuipOptions): string {
  const examples = V1_SAMPLE_QUIPS.map((q, i) => `${i + 1}. ${q}`).join('\n');
  const reminderNote = twoDayReminder
    ? 'This is the 48-hour early reminder, so a nudge-not-yell tone.'
    : 'This is the day-of reminder, so urgency is fair game.';
  const persona = PERSONAS[Math.floor(Math.random() * PERSONAS.length)];

  const contextLines = [`Context: the next raid is on ${raidDay}. ${reminderNote}`];
  if (typeof unsignedCount === 'number' && unsignedCount > 0) {
    contextLines.push(`${unsignedCount} raiders still haven't signed up.`);
  }
  if (progression) {
    contextLines.push(
      progression.mode === 'progress'
        ? `The guild is currently progressing ${progression.bossName} in ${progression.raidName} (${progression.killed}/${progression.total}M).`
        : `The guild has ${progression.raidName} on farm — ${progression.bossName} is dead, now it's reclear season.`,
    );
  }

  const toneLine =
    overlordNames.length > 0
      ? `Tone: playful, sarcastic, WoW-themed. Occasionally reference the guild's Overlords (${overlordNames.join(', ')}). OK to be cheeky; keep it safe for a shared Discord channel.`
      : 'Tone: playful, sarcastic, WoW-themed. OK to be cheeky; keep it safe for a shared Discord channel.';

  const lines = [
    'You write one-line nudges that a World of Warcraft raiding guild uses to get their raiders to sign up for the next raid.',
    '',
    ...contextLines,
    '',
    toneLine,
    `Write in the voice of a ${persona}.`,
    "You may reference a classic WoW meme (Leeroy Jenkins, 'more dots', 'You are not prepared', 'You face Jaina') or a currently trending internet meme — if you go trending, use web search to find one.",
    "Use at most one or two of these flavour elements (the persona is always on); don't cram everything into one line.",
    '',
    'Examples of the tone:',
    examples,
  ];

  if (recentQuips.length > 0) {
    lines.push('', 'Recent quips — write something clearly different from all of these:');
    lines.push(...recentQuips.map((q, i) => `${i + 1}. ${q}`));
  }

  lines.push('', 'Write ONE quip. Plain text, no quotes, no preamble, no markdown. Under 200 characters. Just the quip.');
  return lines.join('\n');
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  modelVersion?: string;
  error?: { message?: string };
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function callGemini(apiKey: string, prompt: string): Promise<ProviderResult> {
  // Send the key in the x-goog-api-key header rather than as a query param.
  const response = await fetchWithTimeout(GEMINI_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.9, topP: 0.95, maxOutputTokens: 120 },
    }),
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
  const parts = candidate?.content?.parts ?? [];
  const text = parts
    .map((p) => p.text ?? '')
    .join('')
    .trim();
  if (!text) {
    logger.warn(
      'QuipGen',
      `Gemini returned no text (finishReason: ${candidate?.finishReason ?? 'unknown'})`,
    );
    return { text: null, resolvedModel: json.modelVersion ?? null };
  }
  return { text, resolvedModel: json.modelVersion ?? null };
}

interface OpenAIResponse {
  choices?: Array<{ message?: { content?: string } }>;
  model?: string;
  error?: { message?: string };
}

async function callOpenAI(apiKey: string, prompt: string): Promise<ProviderResult> {
  const response = await fetchWithTimeout(OPENAI_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 120,
      temperature: 0.9,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`OpenAI HTTP ${response.status}: ${body.slice(0, 200)}`);
  }

  const json = (await response.json()) as OpenAIResponse;
  if (json.error?.message) {
    throw new Error(`OpenAI API error: ${json.error.message}`);
  }

  const text = json.choices?.[0]?.message?.content?.trim() ?? '';
  if (!text) {
    logger.warn('QuipGen', 'OpenAI returned no text');
    return { text: null, resolvedModel: json.model ?? null };
  }
  return { text, resolvedModel: json.model ?? null };
}

const ANTHROPIC_VERSION = '2023-06-01';

interface AnthropicResponse {
  content?: Array<{ type?: string; text?: string }>;
  model?: string;
  error?: { message?: string };
}

async function callClaude(apiKey: string, prompt: string): Promise<ProviderResult> {
  const response = await fetchWithTimeout(ANTHROPIC_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 120,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Anthropic HTTP ${response.status}: ${body.slice(0, 200)}`);
  }

  const json = (await response.json()) as AnthropicResponse;
  if (json.error?.message) {
    throw new Error(`Anthropic API error: ${json.error.message}`);
  }

  const text = (json.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
    .trim();
  if (!text) {
    logger.warn('QuipGen', 'Anthropic returned no text');
    return { text: null, resolvedModel: json.model ?? null };
  }
  return { text, resolvedModel: json.model ?? null };
}

// Gemini sometimes wraps its answer in quotes, returns a numbered list
// with multiple options, or prefaces with "Here's one:". Strip the obvious
// junk. If anything weird remains we'll fall through to the length guard.
//
// The model occasionally uses typographic/"smart" quotes instead of ASCII.
// Cover both ends: "..." / '...' / “...” / ‘...’
const OPEN_QUOTES = new Set(['"', "'", '\u201C', '\u2018']);
const CLOSE_QUOTES = new Set(['"', "'", '\u201D', '\u2019']);

function normalizeQuip(raw: string): string {
  // Take the first non-empty line. split() materializes all lines up front;
  // .find short-circuits on the first match so we don't trim/inspect the
  // rest, but the array allocation still happens. Quips max out around
  // 280 chars anyway — not worth optimizing past this shape.
  const firstLine = raw.split(/\r?\n/).find((l) => l.trim().length > 0);
  let s = (firstLine ?? raw).trim();

  // Drop "1. " / "- " / "* " list prefixes.
  s = s.replace(/^(?:\d+\.\s+|-\s+|\*\s+)/, '');

  // Drop a single surrounding quote pair — ASCII or smart. We don't try to
  // match open-with-close (e.g. "..." closed by ’); anything that symmetric
  // gets stripped.
  const first = s[0];
  const last = s[s.length - 1];
  if (first && last && OPEN_QUOTES.has(first) && CLOSE_QUOTES.has(last)) {
    s = s.slice(1, -1).trim();
  }

  return s;
}

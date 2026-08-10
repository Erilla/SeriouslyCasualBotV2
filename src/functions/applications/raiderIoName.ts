/**
 * Helpers for deriving a character name from a Raider.IO profile URL supplied
 * in an application answer.
 *
 * Raider.IO profile URLs look like:
 *   https://raider.io/characters/<region>/<realm>/<name>[/...][?...]
 * The final path segment is the character name (URL-encoded, lowercased in the
 * slug). We don't depend on the URL scheme or which question carries it — we
 * just look for the unambiguous `raider.io/characters/...` shape in any answer.
 */

import { collectCharacterLinkCandidates, type RaiderIoCharacter } from './characterLinks.js';

export type { RaiderIoCharacter } from './characterLinks.js';

const RAIDER_IO_CHARACTER_COMPAT_URL =
  /(?<![a-z0-9.-])(?:https?:\/\/)?(?:www\.)?raider\.io\/characters\/([^/\s]+)\/([^/\s]+)\/([^/?#\s>)*)]+)/i;

/**
 * Extract a character name from a single piece of text containing a Raider.IO
 * profile URL. Returns the decoded, capitalised name, or null if no Raider.IO
 * character URL is present.
 */
export function parseRaiderIoCharacterName(text: string): string | null {
  const character = parseRaiderIoCharacter(text);
  return character ? capitaliseName(character.name) : null;
}

/**
 * Scan a set of application answers for a Raider.IO profile URL and return the
 * character name from the first one found, or null if none contain one.
 */
export function deriveCharacterNameFromAnswers(answers: { answer: string }[]): string | null {
  for (const a of answers) {
    const name = parseRaiderIoCharacterName(a.answer);
    if (name) return name;
  }
  return null;
}

function capitaliseName(name: string): string {
  return name.charAt(0).toLocaleUpperCase() + name.slice(1);
}

/**
 * Region, realm slug and name from the first Raider.IO character URL in `text`.
 * WarcraftLogs and Blizzard both need all three, so unlike
 * parseRaiderIoCharacterName this keeps the path segments.
 */
export function parseRaiderIoCharacter(text: string): RaiderIoCharacter | null {
  const candidate = collectCharacterLinkCandidates(text).find(
    ({ source }) => source === 'raiderio',
  );
  if (candidate?.source === 'raiderio') return candidate.character;

  const match = text.match(RAIDER_IO_CHARACTER_COMPAT_URL);
  if (!match) return null;
  const realm = decodeCompatSegment(match[2]);
  const name = decodeCompatSegment(match[3]);
  if (!realm || !name) return null;
  return { region: match[1].toLowerCase(), realm: realm.toLowerCase(), name };
}

function decodeCompatSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw).trim() || null;
  } catch {
    return raw.trim() || null;
  }
}

/**
 * Every distinct character named anywhere in the answers, in order of
 * appearance. Applicants routinely link a second character ("I can also play
 * <link>") and those are always swept, so we cannot stop at the first URL the
 * way deriveCharacterNameFromAnswers does.
 */
export function collectRaiderIoCharacters(answers: { answer: string }[]): RaiderIoCharacter[] {
  const seen = new Set<string>();
  const out: RaiderIoCharacter[] = [];
  for (const a of answers) {
    for (const candidate of collectCharacterLinkCandidates(a.answer)) {
      if (candidate.source !== 'raiderio') continue;
      const { character } = candidate;
      const key = `${character.realm}/${character.name.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(character);
    }
  }
  return out;
}

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

const RAIDER_IO_CHARACTER_URL = /raider\.io\/characters\/[^/\s]+\/[^/\s]+\/([^/?#\s]+)/i;

const RAIDER_IO_CHARACTER_URL_G = /raider\.io\/characters\/([^/\s]+)\/([^/\s]+)\/([^/?#\s]+)/gi;

export interface RaiderIoCharacter {
  region: string;
  realm: string;
  name: string;
}

/**
 * Extract a character name from a single piece of text containing a Raider.IO
 * profile URL. Returns the decoded, capitalised name, or null if no Raider.IO
 * character URL is present.
 */
export function parseRaiderIoCharacterName(text: string): string | null {
  const match = text.match(RAIDER_IO_CHARACTER_URL);
  if (!match) return null;

  let name: string;
  try {
    name = decodeURIComponent(match[1]);
  } catch {
    // Malformed percent-encoding — fall back to the raw slug.
    name = match[1];
  }

  name = name.trim();
  if (!name) return null;

  // Raider.IO slugs are lowercase; present the name with a leading capital.
  return name.charAt(0).toLocaleUpperCase() + name.slice(1);
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

function decodeName(raw: string): string | null {
  let name: string;
  try {
    name = decodeURIComponent(raw);
  } catch {
    name = raw;
  }
  name = name.trim();
  if (!name) return null;
  return name.charAt(0).toLocaleUpperCase() + name.slice(1);
}

/**
 * Region, realm slug and name from the first Raider.IO character URL in `text`.
 * WarcraftLogs and Blizzard both need all three, so unlike
 * parseRaiderIoCharacterName this keeps the path segments.
 */
export function parseRaiderIoCharacter(text: string): RaiderIoCharacter | null {
  const match = new RegExp(RAIDER_IO_CHARACTER_URL_G.source, 'i').exec(text);
  if (!match) return null;
  const name = decodeName(match[3]);
  if (!name) return null;
  return { region: match[1].toLowerCase(), realm: match[2].toLowerCase(), name };
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
    for (const m of a.answer.matchAll(RAIDER_IO_CHARACTER_URL_G)) {
      const name = decodeName(m[3]);
      if (!name) continue;
      const realm = m[2].toLowerCase();
      const key = `${realm}/${name.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ region: m[1].toLowerCase(), realm, name });
    }
  }
  return out;
}

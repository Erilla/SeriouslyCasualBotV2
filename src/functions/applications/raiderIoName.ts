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

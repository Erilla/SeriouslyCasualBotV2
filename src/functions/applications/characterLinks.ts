export interface RaiderIoCharacter {
  region: string;
  realm: string;
  name: string;
}

export type CharacterLinkCandidate =
  | { source: 'warcraftlogs-id'; index: number; wclId: number }
  | {
      source: 'raiderio' | 'warcraftlogs-name' | 'armory' | 'wowprogress';
      index: number;
      character: RaiderIoCharacter;
    };

type CharacterSource = Exclude<CharacterLinkCandidate['source'], 'warcraftlogs-id'>;

const NAME_TERMINATOR = '/?#\\s>)*';
const URL_PREFIX = `(?<![a-z0-9.-])(?:https?:\\/\\/)?`;

function decodeSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw).trim() || null;
  } catch {
    return null;
  }
}

/** Only the first letter: the rest may legitimately be mixed case. */
function capitaliseName(name: string): string {
  return name.charAt(0).toLocaleUpperCase() + name.slice(1);
}

function characterCandidate(
  source: CharacterSource,
  index: number,
  region: string,
  realm: string,
  name: string,
): CharacterLinkCandidate | null {
  const decodedRealm = decodeSegment(realm);
  const decodedName = decodeSegment(name);
  if (!decodedRealm || !decodedName) return null;

  return {
    source,
    index,
    character: {
      region: region.toLowerCase(),
      realm: decodedRealm.toLowerCase(),
      // Profile URLs carry lowercase slugs, but this name is displayed to
      // reviewers and stored on the job row, so it is presented the way WoW
      // presents it. Without this a pasted `.../draenor/brentpriest` renders as
      // "brentpriest-Draenor" in the found-characters embed.
      name: capitaliseName(decodedName),
    },
  };
}

function collectCharacters(
  text: string,
  source: CharacterSource,
  expression: RegExp,
): CharacterLinkCandidate[] {
  const candidates: CharacterLinkCandidate[] = [];
  for (const match of text.matchAll(expression)) {
    const candidate = characterCandidate(source, match.index, match[1], match[2], match[3]);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

/** Finds character URLs from supported profile providers in textual order. */
export function collectCharacterLinkCandidates(text: string): CharacterLinkCandidate[] {
  const raiderIo = new RegExp(
    `${URL_PREFIX}(?:www\\.)?raider\\.io\\/characters\\/([^/\\s]+)\\/([^/\\s]+)\\/([^${NAME_TERMINATOR}]+)`,
    'gi',
  );
  const warcraftLogsName = new RegExp(
    `${URL_PREFIX}(?:[a-z0-9-]+\\.)*warcraftlogs\\.com\\/character\\/([^/\\s]+)\\/([^/\\s]+)\\/([^${NAME_TERMINATOR}]+)`,
    'gi',
  );
  const warcraftLogsId = new RegExp(
    `${URL_PREFIX}(?:[a-z0-9-]+\\.)*warcraftlogs\\.com\\/character\\/id\\/([1-9][0-9]*)(?=[${NAME_TERMINATOR}]|$)`,
    'gi',
  );
  const armory = new RegExp(
    `${URL_PREFIX}worldofwarcraft\\.blizzard\\.com\\/(?:[a-z]{2}(?:[_-][a-z]{2})?\\/)?character\\/([^/\\s]+)\\/([^/\\s]+)\\/([^${NAME_TERMINATOR}]+)`,
    'gi',
  );
  const wowProgress = new RegExp(
    `${URL_PREFIX}(?:www\\.)?wowprogress\\.com\\/character\\/([^/\\s]+)\\/([^/\\s]+)\\/([^${NAME_TERMINATOR}]+)`,
    'gi',
  );

  const candidates = [
    ...collectCharacters(text, 'raiderio', raiderIo),
    ...collectCharacters(text, 'warcraftlogs-name', warcraftLogsName),
    ...collectCharacters(text, 'armory', armory),
    ...collectCharacters(text, 'wowprogress', wowProgress),
  ];

  for (const match of text.matchAll(warcraftLogsId)) {
    candidates.push({ source: 'warcraftlogs-id', index: match.index, wclId: Number(match[1]) });
  }

  return candidates.sort((left, right) => left.index - right.index);
}

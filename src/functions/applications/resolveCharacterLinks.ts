import { resolveRealmSlug } from '../../services/blizzard.js';
import { getCharacterSummary } from '../../services/raiderio.js';
import { resolveWclCharacterIds } from '../../services/warcraftlogs.js';
import type { CharacterLinkCandidate, RaiderIoCharacter } from './characterLinks.js';

export type CharacterLinkStatus = 'unresolved' | 'unavailable' | 'verified';

export interface CharacterLinkResolutionStatus {
  candidate: CharacterLinkCandidate;
  identity: RaiderIoCharacter | null;
  status: CharacterLinkStatus;
}

export interface CharacterLinkResolution {
  identities: RaiderIoCharacter[];
  /** Empty unless the caller asked to verify; see resolveCharacterLinks. */
  statuses: CharacterLinkResolutionStatus[];
}

function identityKey(character: RaiderIoCharacter): string {
  return `${character.region}/${character.realm}/${character.name}`.toLocaleLowerCase();
}

async function canonicalizeCandidate(
  candidate: CharacterLinkCandidate,
  wclCharacters: Map<number, RaiderIoCharacter | null>,
): Promise<RaiderIoCharacter | null> {
  const character =
    candidate.source === 'warcraftlogs-id'
      ? (wclCharacters.get(candidate.wclId) ?? null)
      : candidate.character;
  if (!character) return null;

  const region = character.region.trim().toLocaleLowerCase();
  const inputRealm = character.realm.trim();
  const realm =
    candidate.source === 'wowprogress' &&
    region === 'eu' &&
    inputRealm.toLocaleLowerCase() === 'aggra'
      ? 'aggra-português'
      : inputRealm;

  return {
    region,
    realm: await resolveRealmSlug(region, realm),
    name: character.name.trim(),
  };
}

/**
 * Canonicalize parsed link candidates and independently classify link rendering.
 *
 * `verify` controls only whether `statuses` can distinguish `verified` from
 * `unavailable`, which costs one Raider.IO lookup per resolved identity. Callers
 * that only want the identities — the message-harvest path runs on every pasted
 * link — must leave it off rather than pay for a classification they discard.
 * Verification never gates sweep eligibility either way.
 */
export async function resolveCharacterLinks(
  candidates: CharacterLinkCandidate[],
  options: { verify?: boolean } = {},
): Promise<CharacterLinkResolution> {
  const orderedCandidates = [...candidates].sort((left, right) => left.index - right.index);
  const wclIds = orderedCandidates
    .filter((candidate) => candidate.source === 'warcraftlogs-id')
    .map((candidate) => candidate.wclId);
  const wclCharacters = await resolveWclCharacterIds(wclIds);
  const canonical = await Promise.all(
    orderedCandidates.map((candidate) => canonicalizeCandidate(candidate, wclCharacters)),
  );

  const identities: RaiderIoCharacter[] = [];
  const identitiesByKey = new Map<string, RaiderIoCharacter>();
  for (const identity of canonical) {
    if (!identity) continue;
    const key = identityKey(identity);
    if (identitiesByKey.has(key)) continue;
    identitiesByKey.set(key, identity);
    identities.push(identity);
  }

  const verification = new Map<string, boolean>();
  if (options.verify) {
    await Promise.all(
      identities.map(async (identity) => {
        verification.set(identityKey(identity), (await getCharacterSummary(identity)) !== null);
      }),
    );
  }

  // Empty rather than a list of `unavailable`: without a verification pass the
  // rendering status is genuinely unknown, and reporting "Raider.IO could not
  // confirm this" for a lookup nobody performed would be a lie.
  if (!options.verify) return { identities, statuses: [] };

  const statuses = orderedCandidates.map((candidate, index): CharacterLinkResolutionStatus => {
    const identity = canonical[index];
    if (!identity) return { candidate, identity: null, status: 'unresolved' };
    return {
      candidate,
      identity,
      status: verification.get(identityKey(identity)) ? 'verified' : 'unavailable',
    };
  });

  return { identities, statuses };
}

import { getCharacterSummary } from '../../services/raiderio.js';
import { logger } from '../../services/logger.js';
import { resolveWclCharacterIds } from '../../services/warcraftlogs.js';
import type { CharacterLinkCandidate, RaiderIoCharacter } from './characterLinks.js';

/**
 * Candidates resolved in one call.
 *
 * The binding constraint is the WarcraftLogs batch: resolveWclCharacterIds builds
 * a single GraphQL document with one aliased `character(id:)` field per ID, so an
 * uncapped paste of a few hundred links becomes one query that is both likely to
 * be rejected for complexity and billed against the hourly point budget every
 * other applicant's sweep shares. Truncation is logged, never silent.
 */
export const MAX_LINK_CANDIDATES = 30;

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

  // Deliberately NOT rewritten to Blizzard's canonical slug.
  //
  // Blizzard and Raider.IO disagree: Blizzard deletes a hyphen it treats as part
  // of the name (`azjol-nerub` -> `azjolnerub`) while Raider.IO keeps it. Every
  // consumer of these identities is Raider.IO-shaped — applyLinkedCharacters
  // compares them against applicant characters parsed from raider.io URLs, and
  // discoverAlts feeds them to getCharacterSummary / getCharacterOwner — so
  // converting here would make a pasted raider.io URL fail to match the identical
  // URL in the application, duplicating the finding and rooting a rescued sweep on
  // a realm Raider.IO does not recognise.
  //
  // Nothing is lost: the three Blizzard entry points (getCharacterFingerprint,
  // getCharacterEquipment, getBlizzardGuildRoster) each call resolveRealmSlug on
  // the way in, so the Blizzard vocabulary is applied exactly where it is needed.
  //
  // Space-to-hyphen only, which is the Raider.IO slug shape. Accents and existing
  // hyphens are preserved precisely because that is where the two vocabularies
  // part company.
  return {
    region,
    realm: realm.toLocaleLowerCase().replace(/\s+/g, '-'),
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
  const ordered = [...candidates].sort((left, right) => left.index - right.index);
  if (ordered.length > MAX_LINK_CANDIDATES) {
    logger.warn(
      'Applications',
      `Ignoring ${ordered.length - MAX_LINK_CANDIDATES} of ${ordered.length} character links beyond the per-resolution cap`,
    );
  }
  const orderedCandidates = ordered.slice(0, MAX_LINK_CANDIDATES);
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

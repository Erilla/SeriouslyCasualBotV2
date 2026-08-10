import type { RaiderIoCharacter } from './characterLinks.js';
import type { IntelJobRow } from '../../types/index.js';
import {
  getApplicantCharacters,
  getLinkedCharacters,
  requestTopUp,
  setJobPrimary,
  setLinkedCharacters,
} from './intel/jobStore.js';

/**
 * Most linked characters one application can accumulate.
 *
 * Anyone who can post in the application channel can paste character URLs, and
 * every accepted one costs a paced Raider.IO lookup plus guild-frontier expansion
 * on the next sweep — out of a queue and a WarcraftLogs point budget that every
 * other applicant's sweep shares. Well above any honest conversation; low enough
 * that a wall of URLs cannot monopolise the queue.
 */
export const MAX_LINKED_CHARACTERS = 24;

function identityKey(character: RaiderIoCharacter): string {
  return [character.region, character.realm, character.name]
    .map((part) => part.trim().normalize('NFC').toLowerCase())
    .join('/');
}

/**
 * Persist whichever resolved identities the job has not already seen, and ask for
 * a top-up if any were new.
 *
 * Shared by the two ways a link reaches the sweep — an officer pressing Refresh
 * and the applicant pasting one into the conversation — because the decisions
 * after resolution are identical and getting them to disagree would mean one
 * route double-counting characters the other had already queued.
 *
 * Returns the newly persisted characters in resolution order; empty means nothing
 * was written and no top-up was requested, so a redundant scan costs nothing.
 */
export function applyLinkedCharacters(
  job: IntelJobRow,
  declaredCharacterName: string | null,
  identities: RaiderIoCharacter[],
): RaiderIoCharacter[] {
  const alreadyLinked = getLinkedCharacters(job.id);
  const seen = new Set([...getApplicantCharacters(job.id), ...alreadyLinked].map(identityKey));
  const remaining = Math.max(0, MAX_LINKED_CHARACTERS - alreadyLinked.length);
  const novel = identities
    .filter((identity) => {
      const key = identityKey(identity);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, remaining);
  if (novel.length === 0) return [];

  setLinkedCharacters(job.id, novel);

  // A job reserved without a primary takes one now. Prefer the character the
  // application itself named — the applicant's own answer is better evidence of
  // who they are than whichever URL happened to appear first — then link order.
  // setJobPrimary refuses to revise an existing primary, so this is safe to
  // attempt on every append.
  if (job.character_name === '') {
    const declared = declaredCharacterName?.trim().toLocaleLowerCase();
    const byName = declared
      ? novel.find((identity) => identity.name.trim().toLocaleLowerCase() === declared)
      : undefined;
    setJobPrimary(job.id, byName ?? novel[0]);
  }

  requestTopUp(job.id);
  return novel;
}

import { logger } from '../../../services/logger.js';
import { mapLimit } from '../../../utils/concurrency.js';
import { getFindings, setDiscordStatus } from '../intel/jobStore.js';
import type { RaiderIoCharacter } from '../raiderIoName.js';
import {
  RAIDERIO_INTERNAL_CHARACTER_CONCURRENCY,
  type CharacterOwner,
} from '../../../services/raiderioInternal.js';

export interface ConfirmDeps {
  getCharacterOwner: (c: RaiderIoCharacter) => Promise<CharacterOwner | null>;
  /** Pace between internal-API calls; 0 in tests. */
  paceMs?: number;
}

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();

/**
 * Compare each found character's `discord_profile` against the applicant's Discord
 * username: equal proves the account, different proves someone else's.
 *
 * A confirmation pass, never a search — the relationship runs one way (character →
 * handle) and no site offers a Discord→character lookup. Nor can it be a sweep: one
 * internal-API call per candidate is hours across 3,000 roster candidates, against
 * ~2 minutes for the fingerprint. Over the 5–20 characters actually found it is
 * seconds, though rather more than the "~15" this comment used to claim — the
 * first job to run it for real measured 88.5s on 18 characters, which is what
 * prompted the concurrency below.
 *
 * A mismatch is recorded, not dropped. The fingerprint evidence still stands, and a
 * reviewer is better served by the contradiction than by our arbitration of it.
 */
export async function confirmDiscord(
  jobId: number,
  region: string,
  applicantDiscord: string | null,
  deps: ConfirmDeps,
): Promise<{ confirmed: number; mismatched: number }> {
  if (!applicantDiscord) return { confirmed: 0, mismatched: 0 };

  const wanted = applicantDiscord.toLowerCase();
  const pace = deps.paceMs ?? 0;
  let confirmed = 0;
  let mismatched = 0;

  // The applicant told us about these; there is nothing to confirm.
  const toConfirm = getFindings(jobId).filter((f) => f.source !== 'application');

  // Concurrent, each worker still pacing itself. Serially this was the single
  // largest phase of a measured job — 88.5s of 151.9s across 18 characters — and
  // one paced request per character is all it is. Verified byte-identical against
  // a paced serial baseline before raising; see the constant's comment, and do not
  // raise it without repeating that check, because a dropped payload here reads as
  // "this character exposes no Discord handle".
  //
  // Order does not matter to the OUTCOME: setDiscordStatus is keyed by character
  // and the two counters are sums.
  await mapLimit(toConfirm, RAIDERIO_INTERNAL_CHARACTER_CONCURRENCY, async (finding) => {
    let owner: CharacterOwner | null = null;
    try {
      owner = await deps.getCharacterOwner({
        region,
        realm: finding.realm,
        name: finding.name,
      });
    } catch (error) {
      // One unreadable character must not abort the rest of the pass. Caught
      // INSIDE the worker, so a rejection cannot cancel the others either.
      logger.warn(
        'Alts',
        `Discord confirmation failed for ${finding.name}-${finding.realm}: ${error}`,
      );
    }
    await sleep(pace);

    const handle = owner?.discordProfile;
    if (!handle) return;

    if (handle.toLowerCase() === wanted) {
      setDiscordStatus(jobId, finding.name, finding.realm, 'confirmed', handle);
      confirmed++;
    } else {
      setDiscordStatus(jobId, finding.name, finding.realm, 'mismatch', handle);
      mismatched++;
    }
  });

  return { confirmed, mismatched };
}

import { logger } from '../../../services/logger.js';
import { mapLimit } from '../../../utils/concurrency.js';
import { normalizeRealmSlug } from '../../../services/blizzard.js';
import { addFinding, getFindings, setDiscordStatus } from '../intel/jobStore.js';
import type { RaiderIoCharacter } from '../characterLinks.js';
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
 * The sources disagree on realm format — findings hold a slug, and Raider.IO's
 * `main_character` yields whatever its path carried — so both sides are
 * normalised before they are compared, exactly as discoverAlts does.
 */
const key = (name: string, realm: string): string =>
  `${name}-${normalizeRealmSlug(realm)}`.toLowerCase();

/**
 * Compare each found character's `discord_profile` against the applicant's Discord
 * username: equal proves the account, different proves someone else's. The same
 * response also carries the character's declared main, which is read here for the
 * back-link described below.
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
 *
 * The pass also records the declared-main BACK-LINK. discoverAlts reads that
 * relationship forwards only — "who does the applicant say their main is?" — but
 * Raider.IO records the claim on the alt, so an applicant who declares nothing
 * while their alt names them stays a bare fingerprint guess. Live case: Dragonii
 * named Xplendor as its main and was published at 79%. Costs no extra request;
 * the payload was already being fetched and thrown away.
 */
export async function confirmDiscord(
  jobId: number,
  region: string,
  applicantDiscord: string | null,
  deps: ConfirmDeps,
): Promise<{ confirmed: number; mismatched: number; backLinked: number }> {
  const wanted = applicantDiscord?.toLowerCase() ?? null;
  const pace = deps.paceMs ?? 0;
  let confirmed = 0;
  let mismatched = 0;
  let backLinked = 0;

  const findings = getFindings(jobId);
  // The applicant told us about these; there is nothing to confirm.
  const toConfirm = findings.filter((f) => f.source !== 'application');
  // What a back-link must point AT to count. Only characters the applicant named
  // themselves: matching against the whole finding list would let two fingerprint
  // guesses corroborate each other into a 100% claim neither one earned.
  const applicantKeys = new Set(
    findings.filter((f) => f.source === 'application').map((f) => key(f.name, f.realm)),
  );

  // Deliberately NOT gated on `wanted`. The pass used to return here without a
  // handle, which would now also skip the back-link — the one signal that does
  // not involve Discord at all. The cost is one paced lookup per found character
  // (seconds over the 5-20 actually found), not a sweep.
  if (toConfirm.length === 0) return { confirmed, mismatched, backLinked };

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

    // Before the handle, and independent of it: this is the stronger of the two
    // signals, and the weaker one being absent must not skip it.
    const main = owner?.declaredMain;
    if (main && applicantKeys.has(key(main.name, main.realm))) {
      // The whole finding is rewritten rather than just its source, because
      // addFinding is an upsert whose non-COALESCE columns take the values
      // given — passing the row back unchanged is what preserves the class and
      // guild the discovery pass enriched it with. The Discord columns are
      // COALESCEd there, so a verdict recorded by this same worker survives
      // regardless of which of the two lands first.
      addFinding(jobId, { ...finding, source: 'declared alt', confidence: 100 });
      backLinked++;
    }

    const handle = owner?.discordProfile;
    if (!handle || !wanted) return;

    if (handle.toLowerCase() === wanted) {
      setDiscordStatus(jobId, finding.name, finding.realm, 'confirmed', handle);
      confirmed++;
    } else {
      setDiscordStatus(jobId, finding.name, finding.realm, 'mismatch', handle);
      mismatched++;
    }
  });

  return { confirmed, mismatched, backLinked };
}

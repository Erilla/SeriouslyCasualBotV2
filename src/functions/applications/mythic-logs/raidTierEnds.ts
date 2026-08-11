import { getRaidStaticData } from '../../../services/raiderio.js';
import { getCachedOrFetch } from '../../../services/apiCache.js';
import { getCeOverrideCutoff } from '../../guild-info/ceOverrides.js';
import { staticDataFreshness } from '../../guild-info/staticDataFreshness.js';
import { logger } from '../../../services/logger.js';

/**
 * Where the expansion walk starts. Matches quipContext and checkRaidExpansions,
 * which read the same static-data endpoint the same way — Raider.IO has no "list
 * expansions" call, so climbing until one comes back empty is the only way to
 * reach the newest.
 */
const START_EXPANSION = 9;

/**
 * Guards the climb. Without it, a Raider.IO change that started answering every
 * id with a non-empty body would loop until the request budget ran out.
 */
const MAX_EXPANSIONS = 6;

/**
 * When each raid tier stopped counting for Cutting Edge, keyed by Raider.IO raid
 * slug. An open-ended tier maps to null and is still PRESENT — absent and null
 * mean different things to the caller.
 *
 * A slug absent from the map is unknown, which `determineCE` treats as "not
 * ended", so a full clear still reads as CE. That is deliberate and matches the
 * guild achievements panel: the current tier's kills carry an opaque `tier-` slug
 * naming no static raid, and a full clear of a running tier IS CE.
 *
 * The officer `/ceoverride` cutoff wins over Raider.IO's own end date, exactly as
 * it does for the guild's own achievements — so one rule decides what CE means.
 *
 * Never rejects. Guild history must still publish when Raider.IO is unavailable;
 * the cost of a thin map is that a stale full clear can read as CE, the same
 * degradation the achievements panel already accepts.
 */
export async function getRaidTierEnds(): Promise<Map<string, string | null>> {
  const ends = new Map<string, string | null>();

  for (let expansion = START_EXPANSION; expansion < START_EXPANSION + MAX_EXPANSIONS; expansion++) {
    let raids;
    try {
      // The SAME cache key and freshness rule the achievements panel uses, so
      // the two share entries rather than each storing a copy — and an intel
      // sweep costs no Raider.IO request at all for a tier either of them has
      // already fetched. The payload is immutable once every raid has ended;
      // until then it carries a 7-day TTL, and an empty payload is never fresh,
      // so a newly published expansion is still picked up.
      raids =
        (
          await getCachedOrFetch(`static-data:${expansion}`, staticDataFreshness, () =>
            getRaidStaticData(expansion),
          )
        ).raids ?? [];
    } catch {
      // An unknown expansion id is how this walk ends, not a fault: the caller
      // keeps whatever earlier expansions produced.
      break;
    }
    if (raids.length === 0) break;

    for (const raid of raids) {
      let override: string | null = null;
      try {
        override = getCeOverrideCutoff(raid.slug);
      } catch (error) {
        // A database hiccup must not lose the whole tier map.
        logger.warn('Intel', `Could not read the CE override for ${raid.slug}: ${error}`);
      }
      ends.set(raid.slug, override ?? raid.ends.eu);
    }
  }

  return ends;
}

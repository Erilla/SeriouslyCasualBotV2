import { logger } from '../../../services/logger.js';
import { getFindings, setDiscordStatus } from '../intel/jobStore.js';
import type { RaiderIoCharacter } from '../raiderIoName.js';
import type { CharacterOwner } from '../../../services/raiderioInternal.js';

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
 * paced internal-API call per candidate is ~35 minutes across 3,000 roster
 * candidates, against ~2 minutes for the fingerprint. Over the 5–20 characters
 * actually found it costs ~15 seconds.
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

  for (const finding of getFindings(jobId)) {
    // The applicant told us about these; there is nothing to confirm.
    if (finding.source === 'application') continue;

    let owner: CharacterOwner | null = null;
    try {
      owner = await deps.getCharacterOwner({
        region,
        realm: finding.realm,
        name: finding.name,
      });
    } catch (error) {
      // One unreadable character must not abort the rest of the pass.
      logger.warn(
        'Alts',
        `Discord confirmation failed for ${finding.name}-${finding.realm}: ${error}`,
      );
    }
    await sleep(pace);

    const handle = owner?.discordProfile;
    if (!handle) continue;

    if (handle.toLowerCase() === wanted) {
      setDiscordStatus(jobId, finding.name, finding.realm, 'confirmed', handle);
      confirmed++;
    } else {
      setDiscordStatus(jobId, finding.name, finding.realm, 'mismatch', handle);
      mismatched++;
    }
  }

  return { confirmed, mismatched };
}

/** achievement id -> completed timestamp (ms). */
export type Fingerprint = Map<number, number>;

export interface FingerprintMatch {
  identical: number;
  common: number;
  percent: number;
  isMatch: boolean;
}

/**
 * Calibrated against four live accounts: unrelated characters shared a median
 * of 6 identical timestamps out of ~4,000 in common (noise ceiling 3.0%), while
 * genuine same-account pairs ran 31–86%. 20% sits an order of magnitude above
 * the noise and comfortably below the weakest true match observed.
 */
export const MATCH_PERCENT_THRESHOLD = 20;

/** Below this, the sample is too small to judge — a fresh alt with a handful of
 *  account-wide achievements would otherwise score 100%. */
export const MIN_COMMON_ACHIEVEMENTS = 200;

/**
 * Account-wide achievements share an identical completion timestamp across
 * every character on the account, so the proportion of shared achievement ids
 * whose timestamps match identifies same-account characters.
 */
export function compareFingerprints(a: Fingerprint, b: Fingerprint): FingerprintMatch {
  let identical = 0;
  let common = 0;
  for (const [id, timestamp] of a) {
    const other = b.get(id);
    if (other === undefined) continue;
    common++;
    if (other === timestamp) identical++;
  }
  const percent = common === 0 ? 0 : (identical / common) * 100;
  return {
    identical,
    common,
    percent,
    isMatch: common >= MIN_COMMON_ACHIEVEMENTS && percent >= MATCH_PERCENT_THRESHOLD,
  };
}

/**
 * Normalise a name for fuzzy comparison between a WoW character name and a
 * Discord name. Applied symmetrically to BOTH sides before an equality check.
 *
 * Steps (order matters — accents must be folded before non-alphanumerics are
 * stripped, or accented letters would be discarded entirely):
 *   1. Drop the realm suffix: everything from the first '-'. WoW character
 *      names cannot contain '-'; Discord nicks sometimes carry "-Realm".
 *   2. Fold accents to ASCII: NFD-decompose then strip the combining-marks
 *      range U+0300–U+036F, so ü→u, é→e, ï→i, ñ→n.
 *   3. Lowercase.
 *   4. Strip everything outside [a-z0-9] (spaces, punctuation, emoji).
 */
export function normalizeName(name: string): string {
  return name
    .split('-')[0]
    .normalize('NFD')
    .replace(/[\u0300-\u036F]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

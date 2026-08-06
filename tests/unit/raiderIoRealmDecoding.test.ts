import { describe, it, expect } from 'vitest';
import {
  parseRaiderIoCharacter,
  collectRaiderIoCharacters,
} from '../../src/functions/applications/raiderIoName.js';

/**
 * The realm segment of a Raider.IO URL is percent-encoded for accented realms, but
 * was only lowercased, never decoded — while the name segment beside it was decoded.
 * Downstream (`raiderio.ts`, `blizzard.ts`) every realm goes through
 * `encodeURIComponent`, so a still-encoded realm gets encoded a second time:
 * `aggra-portugu%C3%AAs` -> `aggra-portugu%25C3%25AAs`, which 400s. That made every
 * accented realm unresolvable from a pasted URL.
 */
const AGGRA_ENCODED = 'aggra-portugu%C3%AAs';
const AGGRA_DECODED = 'aggra-português';

describe('parseRaiderIoCharacter realm decoding', () => {
  it('percent-decodes the realm segment, not just the name', () => {
    const c = parseRaiderIoCharacter(`https://raider.io/characters/eu/${AGGRA_ENCODED}/thrall`);
    expect(c).not.toBeNull();
    expect(c?.realm).toBe(AGGRA_DECODED);
  });

  it('leaves an unencoded realm untouched', () => {
    const c = parseRaiderIoCharacter('https://raider.io/characters/eu/tarren-mill/thrall');
    expect(c?.realm).toBe('tarren-mill');
  });

  it('lowercases the decoded realm', () => {
    const c = parseRaiderIoCharacter('https://raider.io/characters/eu/Tarren-Mill/thrall');
    expect(c?.realm).toBe('tarren-mill');
  });

  it('falls back to the raw segment on malformed percent-encoding', () => {
    // A lone % is not valid encoding; decodeURIComponent throws. Matches how the
    // name segment already degrades rather than dropping the character entirely.
    const c = parseRaiderIoCharacter('https://raider.io/characters/eu/bad%zz/thrall');
    expect(c).not.toBeNull();
    expect(c?.realm).toBe('bad%zz');
  });
});

describe('collectRaiderIoCharacters realm decoding', () => {
  it('decodes the realm on every collected character', () => {
    const out = collectRaiderIoCharacters([
      { answer: `https://raider.io/characters/eu/${AGGRA_ENCODED}/thrall` },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].realm).toBe(AGGRA_DECODED);
  });

  it('dedupes encoded and decoded spellings of the same realm to one character', () => {
    const out = collectRaiderIoCharacters([
      { answer: `https://raider.io/characters/eu/${AGGRA_ENCODED}/thrall` },
      { answer: `https://raider.io/characters/eu/${AGGRA_DECODED}/thrall` },
    ]);
    expect(out).toHaveLength(1);
  });
});

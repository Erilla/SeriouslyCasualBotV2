import { describe, it, expect } from 'vitest';
import { parseIntelUrls } from '../../src/commands/test.js';
import {
  SEED_CHARACTER,
  SEED_CHARACTER_URL,
} from '../../src/functions/testdata/seedApplication.js';

describe('parseIntelUrls', () => {
  it('parses a single URL', () => {
    expect(parseIntelUrls('https://raider.io/characters/eu/draenor/Brentpriest')).toEqual([
      { region: 'eu', realm: 'draenor', name: 'Brentpriest' },
    ]);
  });

  it('parses several space-separated URLs', () => {
    const parsed = parseIntelUrls(
      'https://raider.io/characters/eu/draenor/Brentpriest https://raider.io/characters/eu/draenor/Brenthunter',
    );
    expect(parsed.map((c) => c.name)).toEqual(['Brentpriest', 'Brenthunter']);
  });

  it('returns an empty array for input with no character URL', () => {
    expect(parseIntelUrls('not a url')).toEqual([]);
  });

  it('deduplicates a repeated URL', () => {
    expect(
      parseIntelUrls(
        'https://raider.io/characters/eu/draenor/Brentpriest https://raider.io/characters/eu/draenor/brentpriest',
      ),
    ).toHaveLength(1);
  });
});

describe('the seeded application names a real character', () => {
  /**
   * The fixture used to be `eu/silvermoon/testcharacter`, which parses fine but
   * does not exist, so every lookup 404s. A seeded application should exercise the
   * sweep for real — and the character must stay parseable, since that is what
   * gates both the placeholders and the queued job.
   */
  it('embeds a parseable Raider.IO URL in the seeded answers', () => {
    const parsed = parseIntelUrls(SEED_CHARACTER_URL);
    expect(parsed).toEqual([
      {
        region: SEED_CHARACTER.region,
        realm: SEED_CHARACTER.realm,
        name: SEED_CHARACTER.name,
      },
    ]);
  });

  it('does not point at the old non-existent test character', () => {
    expect(SEED_CHARACTER_URL).not.toContain('testcharacter');
  });
});

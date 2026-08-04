import { describe, it, expect } from 'vitest';
import { parseIntelUrls } from '../../src/commands/test.js';

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

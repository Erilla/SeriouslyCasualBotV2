import { describe, it, expect } from 'vitest';
import {
  parseRaiderIoCharacterName,
  deriveCharacterNameFromAnswers,
} from '../../src/functions/applications/raiderIoName.js';

describe('parseRaiderIoCharacterName', () => {
  it('extracts and capitalises the name from a full https URL', () => {
    expect(parseRaiderIoCharacterName('https://raider.io/characters/eu/silvermoon/ryanw')).toBe(
      'Ryanw',
    );
  });

  it('works without a scheme and with surrounding text', () => {
    expect(
      parseRaiderIoCharacterName('my profile: raider.io/characters/us/illidan/legolas please'),
    ).toBe('Legolas');
  });

  it('ignores trailing path segments, query strings, and fragments', () => {
    expect(
      parseRaiderIoCharacterName(
        'https://raider.io/characters/eu/draenor/thrall/raids?season=tww-2#m',
      ),
    ).toBe('Thrall');
  });

  it('decodes percent-encoded names (accents)', () => {
    expect(
      parseRaiderIoCharacterName('https://raider.io/characters/eu/argent-dawn/lun%C3%A9shadow'),
    ).toBe('Lunéshadow');
  });

  it('returns null when there is no Raider.IO character URL', () => {
    expect(parseRaiderIoCharacterName('I play a Death Knight, ilvl 620')).toBeNull();
    expect(parseRaiderIoCharacterName('https://raider.io/guilds/eu/silvermoon/Foo')).toBeNull();
  });
});

describe('deriveCharacterNameFromAnswers', () => {
  it('returns the name from the first answer containing a Raider.IO URL', () => {
    const answers = [
      { answer: 'DK' },
      { answer: 'https://raider.io/characters/eu/silvermoon/testcharacter' },
      { answer: 'I am 25 and live in the UK' },
    ];
    expect(deriveCharacterNameFromAnswers(answers)).toBe('Testcharacter');
  });

  it('returns null when no answer contains a Raider.IO URL', () => {
    const answers = [{ answer: 'DK' }, { answer: 'I found you via a friend' }];
    expect(deriveCharacterNameFromAnswers(answers)).toBeNull();
  });
});

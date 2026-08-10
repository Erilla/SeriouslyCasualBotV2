import { describe, expect, it } from 'vitest';
import { collectCharacterLinkCandidates } from '../../src/functions/applications/characterLinks.js';

describe('collectCharacterLinkCandidates', () => {
  it.each([
    ['https://raider.io/characters/eu/argent-dawn/Lun%C3%A9shadow/raids', 'raiderio'],
    ['<https://www.warcraftlogs.com/character/eu/tarren-mill/Thrall>', 'warcraftlogs-name'],
    ['https://www.warcraftlogs.com/character/id/12345', 'warcraftlogs-id'],
    ['https://worldofwarcraft.blizzard.com/en_us/character/eu/tarren-mill/Thrall', 'armory'],
    ['[profile](https://www.wowprogress.com/character/eu/zul-jin/Thrall)', 'wowprogress'],
  ] as const)('parses %s', (url, source) => {
    expect(collectCharacterLinkCandidates(url)[0]?.source).toBe(source);
  });

  it('rejects lookalike hosts and wrappers in names', () => {
    expect(collectCharacterLinkCandidates('https://notraider.io/characters/eu/x/y')).toEqual([]);
    expect(
      collectCharacterLinkCandidates('<https://raider.io/characters/eu/x/Thrall>')[0],
    ).toMatchObject({
      character: { name: 'Thrall' },
    });
  });

  it('returns decoded character tuples in source order', () => {
    expect(
      collectCharacterLinkCandidates(
        'https://www.wowprogress.com/character/eu/zul-jin/Thrall then https://raider.io/characters/eu/argent-dawn/Lun%C3%A9shadow',
      ),
    ).toEqual([
      {
        source: 'wowprogress',
        index: 0,
        character: { region: 'eu', realm: 'zul-jin', name: 'Thrall' },
      },
      {
        source: 'raiderio',
        index: 61,
        character: { region: 'eu', realm: 'argent-dawn', name: 'Lunéshadow' },
      },
    ]);
  });

  it('only accepts positive Warcraft Logs IDs', () => {
    expect(collectCharacterLinkCandidates('https://www.warcraftlogs.com/character/id/0')).toEqual(
      [],
    );
  });
});

/**
 * Profile URLs carry lowercase slugs, but this name is shown to reviewers and
 * stored on the job row. A pasted `.../draenor/brentpriest` rendered as
 * "brentpriest-Draenor" until the capitalisation the old parser applied was
 * restored here.
 */
it('presents a lowercase URL name capitalised', () => {
  const [candidate] = collectCharacterLinkCandidates(
    'https://raider.io/characters/eu/draenor/brentpriest',
  );
  expect(candidate).toMatchObject({ character: { name: 'Brentpriest' } });
});

it('leaves later letters alone so mixed-case names survive', () => {
  const [candidate] = collectCharacterLinkCandidates(
    'https://raider.io/characters/eu/draenor/McSmite',
  );
  expect(candidate).toMatchObject({ character: { name: 'McSmite' } });
});

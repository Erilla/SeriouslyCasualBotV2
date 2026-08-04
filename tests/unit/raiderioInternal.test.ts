import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/services/httpClient.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/httpClient.js')>();
  return { ...actual, httpRequest: vi.fn() };
});

import { httpRequest, HttpError } from '../../src/services/httpClient.js';
import {
  getCharacterOwner,
  getClaimedCharacters,
  getMythicKillDates,
} from '../../src/services/raiderioInternal.js';

const mocked = vi.mocked(httpRequest);
const character = { region: 'eu', realm: 'silvermoon', name: 'Yawnersw' };

beforeEach(() => mocked.mockReset());

describe('getCharacterOwner', () => {
  it('returns the owning user, discord handle and declared main', async () => {
    mocked.mockResolvedValueOnce({
      characterDetails: {
        user: { name: 'binded' },
        characterCustomizations: {
          isClaimed: true,
          discord_profile: 'binded',
          main_character: {
            name: 'Yawnersowo',
            realm: { slug: 'draenor' },
            path: '/characters/eu/draenor/Yawnersowo',
          },
        },
      },
    } as never);

    expect(await getCharacterOwner(character)).toEqual({
      user: 'binded',
      discordProfile: 'binded',
      declaredMain: { region: 'eu', realm: 'draenor', name: 'Yawnersowo' },
    });
  });

  it('returns a null user when privacy hides it but still reports discord', async () => {
    mocked.mockResolvedValueOnce({
      characterDetails: {
        user: null,
        characterCustomizations: { isClaimed: true, discord_profile: 'ictinus' },
      },
    } as never);

    expect(await getCharacterOwner(character)).toEqual({
      user: null,
      discordProfile: 'ictinus',
      declaredMain: null,
    });
  });

  it('returns null when the internal endpoint fails', async () => {
    mocked.mockRejectedValueOnce(
      new HttpError({ service: 'raiderio-internal', status: 500, attempts: 1, message: 'boom' }),
    );
    expect(await getCharacterOwner(character)).toBeNull();
  });
});

describe('getClaimedCharacters', () => {
  it('maps the claimed character list', async () => {
    mocked.mockResolvedValueOnce({
      viewUserCharactersApi: {
        name: 'Zenfu',
        characters: [
          {
            character: {
              name: 'Gorre',
              level: 90,
              class: { name: 'Death Knight' },
              realm: { name: 'Outland' },
            },
          },
        ],
      },
    } as never);

    expect(await getClaimedCharacters('Zenfu')).toEqual([
      { name: 'Gorre', realm: 'Outland', className: 'Death Knight', level: 90 },
    ]);
  });

  it('returns an empty array for an unknown user', async () => {
    mocked.mockResolvedValueOnce({} as never);
    expect(await getClaimedCharacters('nobody')).toEqual([]);
  });
});

describe('getMythicKillDates', () => {
  it('carries the guild each kill happened with, for guild history', async () => {
    mocked.mockResolvedValueOnce({
      characterRaidProgress: {
        raidProgress: [
          {
            raid: 'tier-mn-1',
            encountersDefeated: {
              mythic: [
                {
                  slug: 'imperator-averzian',
                  firstDefeated: '2026-04-23T19:00:00.000Z',
                  guild: { name: 'Hindsight', realm: { slug: 'kazzak' } },
                },
              ],
            },
          },
        ],
      },
    } as never);

    const dates = await getMythicKillDates(character, [35]);
    expect(dates?.[0].guild).toEqual({ name: 'Hindsight', realm: 'kazzak' });
  });

  it('flattens encountersDefeated across the requested tiers', async () => {
    mocked
      .mockResolvedValueOnce({
        characterRaidProgress: {
          raidProgress: [
            {
              raid: 'tier-mn-1',
              encountersDefeated: {
                mythic: [
                  { slug: 'crown-of-the-cosmos', firstDefeated: '2026-04-23T19:00:00.000Z' },
                ],
              },
            },
          ],
        },
      } as never)
      .mockResolvedValueOnce({
        characterRaidProgress: {
          raidProgress: [
            {
              raid: 'manaforge-omega',
              encountersDefeated: {
                mythic: [{ slug: 'dimensius', firstDefeated: '2025-10-30T20:00:00.000Z' }],
              },
            },
          ],
        },
      } as never);

    const dates = await getMythicKillDates(character, [35, 34]);
    expect(dates).toEqual([
      {
        bossName: 'crown-of-the-cosmos',
        firstDefeated: '2026-04-23T19:00:00.000Z',
        guild: null,
        raid: 'tier-mn-1',
      },
      {
        bossName: 'dimensius',
        firstDefeated: '2025-10-30T20:00:00.000Z',
        guild: null,
        raid: 'manaforge-omega',
      },
    ]);
  });

  it('returns null (unknown), never an empty list, when a tier fetch fails', async () => {
    mocked.mockRejectedValueOnce(
      new HttpError({ service: 'raiderio-internal', status: 503, attempts: 1, message: 'nope' }),
    );
    expect(await getMythicKillDates(character, [35])).toBeNull();
  });
});

describe('getMythicKillDates — deduplication and raid names', () => {
  const progress = (raid: string, bosses: [string, string][]) => ({
    characterRaidProgress: {
      raidProgress: [
        {
          raid,
          encountersDefeated: {
            mythic: bosses.map(([slug, firstDefeated]) => ({ slug, firstDefeated })),
          },
        },
      ],
    },
  });

  /**
   * Raider.IO's raid-progress endpoint returns the same raid under EVERY tier
   * ordinal at or after it, verified live: `tier-mn-1`'s 9 Mythic kills came back
   * under tiers 35 through 28, and `sporefall`'s single kill under seven of them.
   * Flattening 8 tier queries therefore counted each kill up to 8 times, which
   * published "72 Mythic kills" for 9 real ones in the guild history.
   */
  it('returns one entry per boss when a raid repeats across tiers', async () => {
    mocked
      .mockResolvedValueOnce(
        progress('sporefall', [['rotmire', '2026-06-17T18:38:09.000Z']]) as never,
      )
      .mockResolvedValueOnce(
        progress('sporefall', [['rotmire', '2026-06-17T18:38:09.000Z']]) as never,
      )
      .mockResolvedValueOnce(
        progress('sporefall', [['rotmire', '2026-06-17T18:38:09.000Z']]) as never,
      );

    const dates = await getMythicKillDates(character, [35, 34, 33]);
    expect(dates).toHaveLength(1);
    expect(dates![0].bossName).toBe('rotmire');
  });

  it('keeps the earliest first-kill date when tiers disagree', async () => {
    mocked
      .mockResolvedValueOnce(
        progress('sporefall', [['rotmire', '2026-07-01T00:00:00.000Z']]) as never,
      )
      .mockResolvedValueOnce(
        progress('sporefall', [['rotmire', '2026-06-17T18:38:09.000Z']]) as never,
      );

    const dates = await getMythicKillDates(character, [35, 34]);
    expect(dates).toHaveLength(1);
    expect(dates![0].firstDefeated).toBe('2026-06-17T18:38:09.000Z');
  });

  it('carries the raid slug so a caller can name the raid', async () => {
    mocked.mockResolvedValueOnce(
      progress('sepulcher-of-the-first-ones', [
        ['vigilant-guardian', '2022-03-27T00:00:00.000Z'],
      ]) as never,
    );

    const dates = await getMythicKillDates(character, [28]);
    expect(dates![0].raid).toBe('sepulcher-of-the-first-ones');
  });
});

describe('getMythicKillDates — tiers fetched concurrently', () => {
  const progress = (raid: string, bosses: [string, string][]) => ({
    characterRaidProgress: {
      raidProgress: [
        {
          raid,
          encountersDefeated: {
            mythic: bosses.map(([slug, firstDefeated]) => ({ slug, firstDefeated })),
          },
        },
      ],
    },
  });

  /**
   * The 8 tier requests now run concurrently — that endpoint measured 1,029ms and
   * 8 serial calls per character were ~52% of a whole job. The UNKNOWN contract
   * must survive it: a partial set would read as "killed nothing else" and move
   * first-kill credit to another character.
   */
  it('returns null when one tier of several fails, discarding the successes', async () => {
    mocked
      .mockResolvedValueOnce(
        progress('sporefall', [['rotmire', '2026-06-17T00:00:00.000Z']]) as never,
      )
      .mockRejectedValueOnce(
        new HttpError({
          service: 'raiderio-internal',
          status: 503,
          attempts: 1,
          message: 'nope',
        }),
      )
      .mockResolvedValueOnce(
        progress('nerubar-palace', [['ulgrax', '2024-09-20T00:00:00.000Z']]) as never,
      );

    expect(await getMythicKillDates(character, [35, 34, 33])).toBeNull();
  });

  it('issues one request per tier', async () => {
    mocked.mockResolvedValue(
      progress('sporefall', [['rotmire', '2026-06-17T00:00:00.000Z']]) as never,
    );
    await getMythicKillDates(character, [35, 34, 33, 32]);
    expect(mocked).toHaveBeenCalledTimes(4);
  });
});

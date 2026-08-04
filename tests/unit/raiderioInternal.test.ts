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
      { bossName: 'crown-of-the-cosmos', firstDefeated: '2026-04-23T19:00:00.000Z', guild: null },
      { bossName: 'dimensius', firstDefeated: '2025-10-30T20:00:00.000Z', guild: null },
    ]);
  });

  it('returns null (unknown), never an empty list, when a tier fetch fails', async () => {
    mocked.mockRejectedValueOnce(
      new HttpError({ service: 'raiderio-internal', status: 503, attempts: 1, message: 'nope' }),
    );
    expect(await getMythicKillDates(character, [35])).toBeNull();
  });
});

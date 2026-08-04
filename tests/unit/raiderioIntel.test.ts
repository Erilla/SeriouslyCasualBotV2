import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/services/httpClient.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/httpClient.js')>();
  return { ...actual, httpRequest: vi.fn() };
});

import { httpRequest, HttpError } from '../../src/services/httpClient.js';
import {
  getCharacterGuild,
  getCharacterSummary,
  getMythicKillCount,
} from '../../src/services/raiderio.js';

const mocked = vi.mocked(httpRequest);
const character = { region: 'eu', realm: 'argent-dawn', name: 'Driptinus' };

beforeEach(() => mocked.mockReset());

describe('getCharacterGuild', () => {
  it("returns the guild's own realm, not the character's", async () => {
    mocked.mockResolvedValueOnce({
      name: 'Driptinus',
      guild: { name: 'Rancour', realm: 'Draenor' },
    } as never);
    expect(await getCharacterGuild(character)).toEqual({ name: 'Rancour', realm: 'Draenor' });
  });

  it('returns null for a guildless character', async () => {
    mocked.mockResolvedValueOnce({ name: 'Driptinus' } as never);
    expect(await getCharacterGuild(character)).toBeNull();
  });

  it('returns null when Raider.IO 404s the character', async () => {
    mocked.mockRejectedValueOnce(
      new HttpError({ service: 'raiderio', status: 404, attempts: 1, message: 'not found' }),
    );
    expect(await getCharacterGuild(character)).toBeNull();
  });
});

describe('getCharacterSummary', () => {
  it('returns class and guild together', async () => {
    mocked.mockResolvedValueOnce({
      name: 'Driptinus',
      class: 'Shaman',
      guild: { name: 'Rancour', realm: 'Draenor' },
    } as never);
    expect(await getCharacterSummary(character)).toEqual({
      className: 'Shaman',
      guild: { name: 'Rancour', realm: 'Draenor' },
    });
  });
});

describe('getMythicKillCount', () => {
  it('sums mythic_bosses_killed across raids', async () => {
    mocked.mockResolvedValueOnce({
      raid_progression: {
        'tier-mn-1': { mythic_bosses_killed: 7, total_bosses: 9 },
        sporefall: { mythic_bosses_killed: 1, total_bosses: 1 },
      },
    } as never);
    expect(await getMythicKillCount(character)).toBe(8);
  });

  it('returns 0 rather than throwing when the lookup fails', async () => {
    mocked.mockRejectedValueOnce(
      new HttpError({ service: 'raiderio', status: 500, attempts: 3, message: 'boom' }),
    );
    expect(await getMythicKillCount(character)).toBe(0);
  });
});

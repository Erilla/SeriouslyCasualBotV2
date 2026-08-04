import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../src/services/httpClient.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/httpClient.js')>();
  return { ...actual, httpRequest: vi.fn() };
});

vi.mock('../../src/config.js', () => ({
  config: {
    warcraftLogsClientId: 'id',
    warcraftLogsClientSecret: 'secret',
    warcraftLogsGuildId: '1',
  },
}));

import { httpRequest } from '../../src/services/httpClient.js';
import {
  getZoneKills,
  getEncounterKills,
  getReportWipes,
  WclPointsExhausted,
  resetAccessTokenCache,
} from '../../src/services/warcraftlogs.js';

const mocked = vi.mocked(httpRequest);
const character = { region: 'eu', realm: 'draenor', name: 'Brenthunter' };
const token = { access_token: 'tok', expires_in: 3600 };

// getAccessToken caches its token for the process lifetime, so without this
// only the first test in the file would actually consume a token mock —
// every later test would consume its "token" mockResolvedValueOnce as the
// GraphQL response instead, shifting every subsequent assertion.
beforeEach(() => {
  mocked.mockReset();
  resetAccessTokenCache();
});
afterEach(() => vi.restoreAllMocks());

describe('getZoneKills', () => {
  it('returns encounter ids with kill counts, dropping zero-kill bosses', async () => {
    mocked.mockResolvedValueOnce(token as never).mockResolvedValueOnce({
      data: {
        characterData: {
          character: {
            zoneRankings: {
              rankings: [
                { encounter: { id: 3135, name: 'Dimensius' }, totalKills: 5 },
                { encounter: { id: 3131, name: "Loom'ithar" }, totalKills: 0 },
              ],
            },
          },
        },
        rateLimitData: { limitPerHour: 9000, pointsSpentThisHour: 10 },
      },
    } as never);

    expect(await getZoneKills(character, 44)).toEqual([{ encounterId: 3135, totalKills: 5 }]);
  });

  it('throws WclPointsExhausted when the hourly budget is nearly spent', async () => {
    mocked.mockResolvedValueOnce(token as never).mockResolvedValueOnce({
      data: {
        characterData: { character: { zoneRankings: { rankings: [] } } },
        rateLimitData: { limitPerHour: 9000, pointsSpentThisHour: 8500 },
      },
    } as never);

    await expect(getZoneKills(character, 44)).rejects.toBeInstanceOf(WclPointsExhausted);
  });

  it('returns an empty array when the character is unknown to WCL', async () => {
    mocked
      .mockResolvedValueOnce(token as never)
      .mockResolvedValueOnce({ data: { characterData: { character: null } } } as never);
    expect(await getZoneKills(character, 44)).toEqual([]);
  });
});

describe('getEncounterKills', () => {
  it("returns the character's own kills sorted oldest first", async () => {
    mocked.mockResolvedValueOnce(token as never).mockResolvedValueOnce({
      data: {
        characterData: {
          character: {
            encounterRankings: {
              ranks: [
                { startTime: 200, report: { code: 'later' } },
                { startTime: 100, report: { code: 'first' } },
              ],
            },
          },
        },
      },
    } as never);

    expect((await getEncounterKills(character, 3135)).map((k) => k.reportCode)).toEqual([
      'first',
      'later',
    ]);
  });

  it('returns an empty array when the kill predates WCL rankings', async () => {
    mocked.mockResolvedValueOnce(token as never).mockResolvedValueOnce({
      data: { characterData: { character: { encounterRankings: { ranks: [] } } } },
    } as never);
    expect(await getEncounterKills(character, 3135)).toEqual([]);
  });
});

describe('getReportWipes', () => {
  it('resolves per-pull rosters from friendlyPlayers and masterData, skipping kills', async () => {
    mocked.mockResolvedValueOnce(token as never).mockResolvedValueOnce({
      data: {
        reportData: {
          report: {
            masterData: {
              actors: [
                { id: 11, name: 'Brentprietwo' },
                { id: 184, name: 'Brenthunter' },
              ],
            },
            fights: [
              {
                id: 6,
                encounterID: 3181,
                kill: false,
                fightPercentage: 12.5,
                friendlyPlayers: [11],
              },
              { id: 7, encounterID: 3181, kill: true, fightPercentage: 0, friendlyPlayers: [184] },
            ],
          },
        },
      },
    } as never);

    expect(await getReportWipes('abc')).toEqual([
      { encounterId: 3181, fightId: 6, fightPercentage: 12.5, players: ['Brentprietwo'] },
    ]);
  });
});

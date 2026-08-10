import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/httpClient.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/httpClient.js')>();
  return { ...actual, httpRequest: vi.fn() };
});

vi.mock('../../src/config.js', () => ({
  config: {
    warcraftLogsClientId: 'test-client-id',
    warcraftLogsClientSecret: 'test-client-secret',
    warcraftLogsGuildId: '1',
  },
}));

import { httpRequest } from '../../src/services/httpClient.js';
import {
  extractMatchingCodes,
  resetAccessTokenCache,
  resolveWclCharacterIds,
  type AttendanceReport,
} from '../../src/services/warcraftlogs.js';

const mockedHttpRequest = vi.mocked(httpRequest);
const token = { access_token: 'test-token', expires_in: 3600 };

beforeEach(() => {
  mockedHttpRequest.mockReset();
  resetAccessTokenCache();
});

describe('extractMatchingCodes', () => {
  const report = (code: string, players: Array<[string, number]>): AttendanceReport => ({
    code,
    players: players.map(([name, presence]) => ({ name, presence, type: 'DPS' })),
  });

  it('matches despite an accent-only difference', () => {
    const reports = [report('AAA', [['Héphaestüs', 1]])];
    expect(extractMatchingCodes(reports, 'Hephaestus')).toEqual(['AAA']);
  });

  it('matches despite a case-only difference', () => {
    const reports = [report('AAA', [['Shadowleif', 1]])];
    expect(extractMatchingCodes(reports, 'SHADOWLEIF')).toEqual(['AAA']);
  });

  it('excludes players who signed up but were not present (presence !== 1)', () => {
    const reports = [report('AAA', [['Thrall', 0]])];
    expect(extractMatchingCodes(reports, 'Thrall')).toEqual([]);
  });

  it('returns [] when no player matches', () => {
    const reports = [report('AAA', [['Jaina', 1]])];
    expect(extractMatchingCodes(reports, 'Thrall')).toEqual([]);
  });

  it('returns all matching report codes in reversed input order', () => {
    const reports = [
      report('FIRST', [['Thrall', 1]]),
      report('SECOND', [['Jaina', 1]]),
      report('THIRD', [['thrall', 1]]),
    ];
    expect(extractMatchingCodes(reports, 'Thrall')).toEqual(['THIRD', 'FIRST']);
  });
});

describe('resolveWclCharacterIds', () => {
  it('does not query non-positive or non-integer IDs', async () => {
    await expect(resolveWclCharacterIds([0, -1, 1.5])).resolves.toEqual(
      new Map([
        [0, null],
        [-1, null],
        [1.5, null],
      ]),
    );
    expect(mockedHttpRequest).not.toHaveBeenCalled();
  });

  it('resolves null and hidden characters in one batched GraphQL request', async () => {
    mockedHttpRequest.mockResolvedValueOnce(token as never).mockResolvedValueOnce({
      data: {
        characterData: {
          c0: null,
          c1: {
            name: 'Hidden',
            hidden: true,
            canonicalID: null,
            server: { slug: 'silvermoon', region: { slug: 'eu' } },
          },
        },
      },
    } as never);

    await expect(resolveWclCharacterIds([10, 11])).resolves.toEqual(
      new Map([
        [10, null],
        [11, { region: 'eu', realm: 'silvermoon', name: 'Hidden' }],
      ]),
    );

    const graphCalls = mockedHttpRequest.mock.calls.filter(
      ([, url]) => url === 'https://www.warcraftlogs.com/api/v2/client',
    );
    expect(graphCalls).toHaveLength(1);
    const body = JSON.parse(String(graphCalls[0][2]?.body)) as {
      query: string;
      variables: Record<string, number>;
    };
    expect(body.variables).toEqual({ id0: 10, id1: 11 });
    expect(body.query).toContain('c0: character(id: $id0)');
    expect(body.query).toContain('c1: character(id: $id1)');
    expect(body.query).toContain('canonicalID');
    expect(body.query).toContain('hidden');
  });

  it('follows canonical IDs exactly once in a single second batch', async () => {
    mockedHttpRequest
      .mockResolvedValueOnce(token as never)
      .mockResolvedValueOnce({
        data: {
          characterData: {
            c0: {
              name: 'Old',
              hidden: false,
              canonicalID: 20,
              server: { slug: 'draenor', region: { slug: 'eu' } },
            },
            c1: {
              name: 'OtherOld',
              hidden: false,
              canonicalID: 30,
              server: { slug: 'illidan', region: { slug: 'us' } },
            },
          },
        },
      } as never)
      .mockResolvedValueOnce({
        data: {
          characterData: {
            c0: {
              name: 'Renamed',
              hidden: false,
              canonicalID: 40,
              server: { slug: 'draenor', region: { slug: 'eu' } },
            },
            c1: {
              name: 'OtherRenamed',
              hidden: false,
              canonicalID: null,
              server: { slug: 'area-52', region: { slug: 'us' } },
            },
          },
        },
      } as never);

    await expect(resolveWclCharacterIds([10, 11])).resolves.toEqual(
      new Map([
        [10, { region: 'eu', realm: 'draenor', name: 'Renamed' }],
        [11, { region: 'us', realm: 'area-52', name: 'OtherRenamed' }],
      ]),
    );

    const graphCalls = mockedHttpRequest.mock.calls.filter(
      ([, url]) => url === 'https://www.warcraftlogs.com/api/v2/client',
    );
    expect(graphCalls).toHaveLength(2);
    const secondBody = JSON.parse(String(graphCalls[1][2]?.body)) as {
      variables: Record<string, number>;
    };
    expect(secondBody.variables).toEqual({ id0: 20, id1: 30 });
  });

  it('treats a null canonical lookup as unresolved', async () => {
    mockedHttpRequest
      .mockResolvedValueOnce(token as never)
      .mockResolvedValueOnce({
        data: {
          characterData: {
            c0: {
              name: 'Stale',
              hidden: false,
              canonicalID: 20,
              server: { slug: 'old-realm', region: { slug: 'eu' } },
            },
          },
        },
      } as never)
      .mockResolvedValueOnce({
        data: { characterData: { c0: null } },
      } as never);

    await expect(resolveWclCharacterIds([10])).resolves.toEqual(new Map([[10, null]]));
  });
});

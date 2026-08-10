import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockedGetCharacterSummary, mockedResolveRealmSlug, mockedResolveWclCharacterIds } =
  vi.hoisted(() => ({
    mockedGetCharacterSummary: vi.fn(),
    mockedResolveRealmSlug: vi.fn(),
    mockedResolveWclCharacterIds: vi.fn(),
  }));

vi.mock('../../src/services/warcraftlogs.js', () => ({
  resolveWclCharacterIds: mockedResolveWclCharacterIds,
}));

vi.mock('../../src/services/blizzard.js', () => ({
  resolveRealmSlug: mockedResolveRealmSlug,
}));

vi.mock('../../src/services/raiderio.js', () => ({
  getCharacterSummary: mockedGetCharacterSummary,
}));

import {
  resolveCharacterLinks,
  type CharacterLinkResolutionStatus,
} from '../../src/functions/applications/resolveCharacterLinks.js';
import type {
  CharacterLinkCandidate,
  RaiderIoCharacter,
} from '../../src/functions/applications/characterLinks.js';

function wclCandidate(wclId: number, index = 0): CharacterLinkCandidate {
  return { source: 'warcraftlogs-id', index, wclId };
}

function namedCandidate(
  source: Exclude<CharacterLinkCandidate['source'], 'warcraftlogs-id'>,
  character: RaiderIoCharacter,
  index: number,
): CharacterLinkCandidate {
  return { source, character, index };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedResolveWclCharacterIds.mockResolvedValue(new Map());
  mockedResolveRealmSlug.mockImplementation(async (_region: string, realm: string) =>
    realm.toLocaleLowerCase(),
  );
  mockedGetCharacterSummary.mockResolvedValue({ className: null, guild: null });
});

describe('resolveCharacterLinks', () => {
  it('marks a null WCL ID unresolved without attempting Raider.IO verification', async () => {
    const candidate = wclCandidate(10);
    mockedResolveWclCharacterIds.mockResolvedValue(new Map([[10, null]]));

    await expect(resolveCharacterLinks([candidate])).resolves.toEqual({
      identities: [],
      statuses: [
        {
          candidate,
          identity: null,
          status: 'unresolved',
        } satisfies CharacterLinkResolutionStatus,
      ],
    });
    expect(mockedGetCharacterSummary).not.toHaveBeenCalled();
  });

  it('keeps a canonical WCL identity when Raider.IO cannot verify it', async () => {
    const candidate = wclCandidate(10);
    const character = { region: 'eu', realm: 'Draenor', name: 'Valid' };
    mockedResolveWclCharacterIds.mockResolvedValue(new Map([[10, character]]));
    mockedGetCharacterSummary.mockResolvedValue(null);

    await expect(resolveCharacterLinks([candidate])).resolves.toEqual({
      identities: [{ region: 'eu', realm: 'draenor', name: 'Valid' }],
      statuses: [
        {
          candidate,
          identity: { region: 'eu', realm: 'draenor', name: 'Valid' },
          status: 'unavailable',
        },
      ],
    });
  });

  it('normalizes and deduplicates identities while retaining source-ordered statuses', async () => {
    const later = namedCandidate(
      'wowprogress',
      { region: 'EU', realm: 'aggra', name: 'Thrall' },
      20,
    );
    const earlier = namedCandidate(
      'raiderio',
      { region: 'eu', realm: 'aggra-português', name: 'THRALL' },
      5,
    );
    mockedResolveRealmSlug.mockImplementation(async (_region: string, realm: string) => {
      if (realm === 'aggra-português') return 'aggra-português';
      return realm;
    });

    const result = await resolveCharacterLinks([later, earlier]);

    expect(result.identities).toEqual([{ region: 'eu', realm: 'aggra-português', name: 'THRALL' }]);
    expect(result.statuses).toEqual([
      {
        candidate: earlier,
        identity: { region: 'eu', realm: 'aggra-português', name: 'THRALL' },
        status: 'verified',
      },
      {
        candidate: later,
        identity: { region: 'eu', realm: 'aggra-português', name: 'Thrall' },
        status: 'verified',
      },
    ]);
    expect(mockedResolveRealmSlug).toHaveBeenNthCalledWith(1, 'eu', 'aggra-português');
    expect(mockedResolveRealmSlug).toHaveBeenNthCalledWith(2, 'eu', 'aggra-português');
    expect(mockedGetCharacterSummary).toHaveBeenCalledTimes(1);
  });

  it('does not apply the WoWProgress EU Aggra alias to other sources', async () => {
    const candidate = namedCandidate('armory', { region: 'eu', realm: 'aggra', name: 'Thrall' }, 0);

    await expect(resolveCharacterLinks([candidate])).resolves.toMatchObject({
      identities: [{ region: 'eu', realm: 'aggra', name: 'Thrall' }],
      statuses: [{ candidate, status: 'verified' }],
    });
  });

  it('batches WCL IDs and verifies every distinct canonical identity', async () => {
    const named = namedCandidate('armory', { region: 'us', realm: 'Area 52', name: 'Jaina' }, 30);
    const wcl = wclCandidate(10, 10);
    mockedResolveWclCharacterIds.mockResolvedValue(
      new Map([[10, { region: 'eu', realm: 'Draenor', name: 'Valid' }]]),
    );
    mockedResolveRealmSlug.mockImplementation(async (_region: string, realm: string) =>
      realm.toLocaleLowerCase().replaceAll(' ', '-'),
    );

    const result = await resolveCharacterLinks([named, wcl]);

    expect(mockedResolveWclCharacterIds).toHaveBeenCalledWith([10]);
    expect(result.identities).toEqual([
      { region: 'eu', realm: 'draenor', name: 'Valid' },
      { region: 'us', realm: 'area-52', name: 'Jaina' },
    ]);
    expect(result.statuses.map(({ status }) => status)).toEqual(['verified', 'verified']);
    expect(mockedGetCharacterSummary).toHaveBeenCalledTimes(2);
  });
});

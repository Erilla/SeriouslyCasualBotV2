import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, getDatabase } from '../../src/database/db.js';
import { createTables } from '../../src/database/schema.js';

vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from '../../src/services/logger.js';

const originalFetch = globalThis.fetch;

function mockResponse(json: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers(),
    json: async () => json,
  } as Response;
}

function stubRequiredEnv(): void {
  vi.stubEnv('DISCORD_TOKEN', 'test-token');
  vi.stubEnv('CLIENT_ID', 'test-client');
  vi.stubEnv('GUILD_ID', 'test-guild');
  vi.stubEnv('OFFICER_ROLE_ID', 'test-role');
  vi.stubEnv('WOWAUDIT_API_SECRET', 'test-secret');
  vi.stubEnv('WARCRAFTLOGS_CLIENT_ID', 'test-wcl-id');
  vi.stubEnv('WARCRAFTLOGS_CLIENT_SECRET', 'test-wcl-secret');
  vi.stubEnv('WARCRAFTLOGS_GUILD_ID', '486913');
  vi.stubEnv('BLIZZARD_CLIENT_ID', 'test-blizzard-id');
  vi.stubEnv('BLIZZARD_CLIENT_SECRET', 'test-blizzard-secret');
  vi.stubEnv('RAIDERIO_GUILD_IDS', '123%2C456');
}

const realmIndex = {
  _links: { self: { href: 'https://eu.api.blizzard.com/data/wow/realm/index' } },
  realms: [
    {
      key: { href: 'https://eu.api.blizzard.com/data/wow/realm/1084' },
      name: 'Tarren Mill',
      id: 1084,
      slug: 'tarren-mill',
    },
    {
      key: { href: 'https://eu.api.blizzard.com/data/wow/realm/1382' },
      name: 'Azjol-Nerub',
      id: 1382,
      slug: 'azjolnerub',
    },
    {
      key: { href: 'https://us.api.blizzard.com/data/wow/realm/61' },
      name: "Zul'jin",
      id: 61,
      slug: 'zuljin',
    },
    {
      key: { href: 'https://eu.api.blizzard.com/data/wow/realm/1303' },
      name: 'Aggra (Português)',
      id: 1303,
      slug: 'aggra-português',
    },
    {
      key: { href: 'https://kr.api.blizzard.com/data/wow/realm/2116' },
      name: '아즈샤라',
      id: 2116,
      slug: 'azshara',
    },
  ],
};

describe('guildNameSlug', () => {
  it('removes punctuation while preserving word separators and accents', async () => {
    const { guildNameSlug } = await import('../../src/services/blizzard.js');

    expect(guildNameSlug(" L'Équipe Seriously-Casual ")).toBe('léquipe-seriouslycasual');
  });
});

describe('resolveRealmSlug', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubRequiredEnv();
    createTables(getDatabase(':memory:'));
  });

  afterEach(() => {
    closeDatabase();
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([
    ['eu', 'Tarren Mill', 'tarren-mill'],
    ['eu', 'Azjol-Nerub', 'azjolnerub'],
    ['us', "Zul'jin", 'zuljin'],
    ['eu', 'aggra-portugues', 'aggra-português'],
    ['kr', '아즈샤라', 'azshara'],
  ])('resolves %s %s through the realm index', async (region, input, expected) => {
    globalThis.fetch = vi.fn((url: string | URL | Request) => {
      const href = String(url);
      if (href === 'https://oauth.battle.net/token') {
        return Promise.resolve(mockResponse({ access_token: 'token', expires_in: 3600 }));
      }
      if (href.includes('/data/wow/realm/index')) return Promise.resolve(mockResponse(realmIndex));
      throw new Error(`Unexpected request: ${href}`);
    }) as typeof globalThis.fetch;

    const { resolveRealmSlug } = await import('../../src/services/blizzard.js');

    await expect(resolveRealmSlug(region, input)).resolves.toBe(expected);
  });

  it('warns and uses the rule fallback when the realm index has no match', async () => {
    globalThis.fetch = vi.fn((url: string | URL | Request) => {
      const href = String(url);
      if (href === 'https://oauth.battle.net/token') {
        return Promise.resolve(mockResponse({ access_token: 'token', expires_in: 3600 }));
      }
      return Promise.resolve(mockResponse(realmIndex));
    }) as typeof globalThis.fetch;

    const { resolveRealmSlug } = await import('../../src/services/blizzard.js');

    await expect(resolveRealmSlug('eu', 'Unlisted Realm')).resolves.toBe('unlisted-realm');
    expect(logger.warn).toHaveBeenCalledWith('Blizzard', expect.stringContaining('Unlisted Realm'));
  });

  it('warns and uses the rule fallback when the realm index cannot be fetched', async () => {
    globalThis.fetch = vi.fn((url: string | URL | Request) => {
      const href = String(url);
      if (href === 'https://oauth.battle.net/token') {
        return Promise.resolve(mockResponse({ access_token: 'token', expires_in: 3600 }));
      }
      return Promise.resolve({
        ...mockResponse({ message: 'forbidden' }),
        ok: false,
        status: 403,
        statusText: 'Forbidden',
      });
    }) as typeof globalThis.fetch;

    const { resolveRealmSlug } = await import('../../src/services/blizzard.js');

    await expect(resolveRealmSlug('eu', 'Tarren Mill')).resolves.toBe('tarren-mill');
    expect(logger.warn).toHaveBeenCalledWith('Blizzard', expect.stringContaining('realm index'));
  });

  it('keeps a regional realm index for seven days and refreshes it after expiry', async () => {
    globalThis.fetch = vi.fn((url: string | URL | Request) => {
      const href = String(url);
      if (href === 'https://oauth.battle.net/token') {
        return Promise.resolve(mockResponse({ access_token: 'token', expires_in: 3600 }));
      }
      return Promise.resolve(mockResponse(realmIndex));
    }) as typeof globalThis.fetch;

    const { resolveRealmSlug } = await import('../../src/services/blizzard.js');

    await resolveRealmSlug('eu', 'Tarren Mill');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://eu.api.blizzard.com/data/wow/realm/index?namespace=dynamic-eu&locale=en_GB',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer token' }),
      }),
    );
    getDatabase()
      .prepare('UPDATE api_cache SET fetched_at = ? WHERE key = ?')
      .run(new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString(), 'realm-index:eu');
    await resolveRealmSlug('eu', 'Azjol-Nerub');

    let realmIndexRequests = vi
      .mocked(globalThis.fetch)
      .mock.calls.filter(([url]) => String(url).includes('/data/wow/realm/index'));
    expect(realmIndexRequests).toHaveLength(1);

    getDatabase()
      .prepare('UPDATE api_cache SET fetched_at = ? WHERE key = ?')
      .run(new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(), 'realm-index:eu');
    await resolveRealmSlug('eu', 'Tarren Mill');

    realmIndexRequests = vi
      .mocked(globalThis.fetch)
      .mock.calls.filter(([url]) => String(url).includes('/data/wow/realm/index'));
    expect(realmIndexRequests).toHaveLength(2);
    expect(
      getDatabase().prepare('SELECT key FROM api_cache WHERE key = ?').get('realm-index:eu'),
    ).toEqual({ key: 'realm-index:eu' });
  });
});

describe('getCharacterEquipment', () => {
  beforeEach(() => {
    vi.resetModules();
    stubRequiredEnv();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('uses a cached OAuth token for encoded equipment profile requests', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ access_token: 'token', expires_in: 3600 }))
      .mockResolvedValueOnce(
        mockResponse({
          equipped_items: [
            {
              slot: { type: 'BACK' },
              item: { name: 'Cape' },
              enchantments: [],
              sockets: [],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(mockResponse({ equipped_items: [] }));

    const { getCharacterEquipment } = await import('../../src/services/blizzard.js');

    const profile = await getCharacterEquipment('eu', 'Tarren Mill', 'TËST CHÀR');
    expect(profile.equipped_items[0].slot.type).toBe('BACK');
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2,
      'https://eu.api.blizzard.com/profile/wow/character/tarren-mill/t%C3%ABst%20ch%C3%A0r/equipment?namespace=profile-eu&locale=en_GB',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer token' }),
      }),
    );

    await getCharacterEquipment('eu', 'silvermoon', 'Second');
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('/profile/wow/character/silvermoon/second/equipment'),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer token' }),
      }),
    );
  });

  it('shares one in-flight OAuth request across concurrent equipment lookups', async () => {
    let resolveToken!: (response: Response) => void;
    const tokenResponse = new Promise<Response>((resolve) => {
      resolveToken = resolve;
    });

    globalThis.fetch = vi.fn((url: string) => {
      if (url === 'https://oauth.battle.net/token') {
        return tokenResponse;
      }

      return Promise.resolve(mockResponse({ equipped_items: [] }));
    }) as typeof globalThis.fetch;

    const { getCharacterEquipment } = await import('../../src/services/blizzard.js');
    const requests = Promise.all([
      getCharacterEquipment('eu', 'silvermoon', 'One'),
      getCharacterEquipment('eu', 'silvermoon', 'Two'),
      getCharacterEquipment('eu', 'silvermoon', 'Three'),
    ]);

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    resolveToken(mockResponse({ access_token: 'token', expires_in: 3600 }));

    await expect(requests).resolves.toHaveLength(3);
    expect(globalThis.fetch).toHaveBeenCalledTimes(4);
  });
});

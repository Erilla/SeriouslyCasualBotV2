import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('getCharacterEquipment', () => {
  beforeEach(() => {
    vi.resetModules();
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

    const profile = await getCharacterEquipment('eu', 'SilverMoon', 'TËST CHÀR');
    expect(profile.equipped_items[0].slot.type).toBe('BACK');
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('/profile/wow/character/silvermoon/t%C3%ABst%20ch%C3%A0r/equipment'),
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

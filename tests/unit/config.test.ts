import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('config', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('should throw if DISCORD_TOKEN is missing', async () => {
    vi.stubEnv('DISCORD_TOKEN', '');
    vi.stubEnv('CLIENT_ID', 'test');
    vi.stubEnv('GUILD_ID', 'test');
    vi.stubEnv('OFFICER_ROLE_ID', 'test');

    await expect(import('../../src/config.js')).rejects.toThrow('DISCORD_TOKEN');
  });

  it('should export valid config when all required vars are set', async () => {
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
    vi.stubEnv('LOG_LEVEL', 'INFO');
    vi.stubEnv('NODE_ENV', 'development');

    const { config } = await import('../../src/config.js');

    expect(config.discordToken).toBe('test-token');
    expect(config.clientId).toBe('test-client');
    expect(config.guildId).toBe('test-guild');
    expect(config.officerRoleId).toBe('test-role');
    expect(config.blizzardClientId).toBe('test-blizzard-id');
    expect(config.blizzardClientSecret).toBe('test-blizzard-secret');
    expect(config.weeklyGearStaleHours).toBe(48);
    expect(config.isDevelopment).toBe(true);
  });

  it('parses raiderIoGuilds with the built-in default identities', async () => {
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

    const { config } = await import('../../src/config.js');

    expect(config.raiderIoGuilds).toEqual([
      { region: 'eu', realm: 'silvermoon', name: 'seriouslycasual' },
      { region: 'eu', realm: 'darksorrow', name: 'seriously casual' },
    ]);
  });

  it('should reject a non-positive weekly gear stale age', async () => {
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
    vi.stubEnv('WEEKLY_GEAR_STALE_HOURS', '0');

    await expect(import('../../src/config.js')).rejects.toThrow('WEEKLY_GEAR_STALE_HOURS');
  });

  it('honours a RAIDERIO_GUILDS env override', async () => {
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
    vi.stubEnv('RAIDERIO_GUILDS', '[{"region":"us","realm":"illidan","name":"other"}]');

    const { config } = await import('../../src/config.js');

    expect(config.raiderIoGuilds).toEqual([{ region: 'us', realm: 'illidan', name: 'other' }]);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('config', () => {
  beforeEach(() => {
    vi.resetModules();
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
    vi.stubEnv('RAIDERIO_GUILD_IDS', '123%2C456');
    vi.stubEnv('LOG_LEVEL', 'INFO');
    vi.stubEnv('NODE_ENV', 'development');

    const { config } = await import('../../src/config.js');

    expect(config.discordToken).toBe('test-token');
    expect(config.clientId).toBe('test-client');
    expect(config.guildId).toBe('test-guild');
    expect(config.officerRoleId).toBe('test-role');
    expect(config.isDevelopment).toBe(true);
  });
});

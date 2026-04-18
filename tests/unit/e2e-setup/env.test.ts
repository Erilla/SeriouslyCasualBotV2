import { describe, it, expect, beforeEach } from 'vitest';
import { loadE2EEnv, resetE2EEnvCache } from '../../../tests/e2e/setup/env.js';

describe('loadE2EEnv', () => {
  beforeEach(() => {
    resetE2EEnvCache();
    for (const k of [
      'DISCORD_TOKEN', 'GUILD_ID',
      'TESTER_PRIMARY_ID', 'VOTER_A_ID', 'VOTER_B_ID', 'OFFICER_ID',
      'TEST_DB_PATH',
    ]) delete process.env[k];
  });

  it('throws a clear error when required keys are missing', () => {
    expect(() => loadE2EEnv({ skipDotenv: true })).toThrow(/missing required e2e env vars/i);
  });

  it('returns a typed object when all keys are present', () => {
    process.env.DISCORD_TOKEN = 'token';
    process.env.GUILD_ID = '1';
    process.env.TESTER_PRIMARY_ID = '2';
    process.env.VOTER_A_ID = '3';
    process.env.VOTER_B_ID = '4';
    process.env.OFFICER_ID = '5';
    // TEST_DB_PATH intentionally not set — verify the default is used
    delete process.env.TEST_DB_PATH;
    const env = loadE2EEnv({ skipDotenv: true });
    expect(env.sandboxGuildId).toBe('1');
    expect(env.testDbPath).toBe('./tests/e2e/.data/test.db');
  });

  it('uses explicit TEST_DB_PATH when provided', () => {
    process.env.DISCORD_TOKEN = 'token';
    process.env.GUILD_ID = '1';
    process.env.TESTER_PRIMARY_ID = '2';
    process.env.VOTER_A_ID = '3';
    process.env.VOTER_B_ID = '4';
    process.env.OFFICER_ID = '5';
    process.env.TEST_DB_PATH = './custom.db';
    const env = loadE2EEnv({ skipDotenv: true });
    expect(env.testDbPath).toBe('./custom.db');
  });
});

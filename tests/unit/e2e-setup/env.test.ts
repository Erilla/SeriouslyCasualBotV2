import { describe, it, expect, beforeEach } from 'vitest';
import { loadE2EEnv, resetE2EEnvCache } from '../../../tests/e2e/setup/env.js';

describe('loadE2EEnv', () => {
  beforeEach(() => {
    resetE2EEnvCache();
    for (const k of [
      'DISCORD_TOKEN_TEST', 'SANDBOX_GUILD_ID',
      'TESTER_PRIMARY_ID', 'VOTER_A_ID', 'VOTER_B_ID', 'OFFICER_ID',
      'TEST_DB_PATH', 'RAIDERIO_API_KEY', 'WOWAUDIT_API_KEY',
    ]) delete process.env[k];
  });

  it('throws a clear error when required keys are missing', () => {
    expect(() => loadE2EEnv()).toThrow(/missing required e2e env vars/i);
  });

  it('returns a typed object when all keys are present', () => {
    process.env.DISCORD_TOKEN_TEST = 'token';
    process.env.SANDBOX_GUILD_ID = '1';
    process.env.TESTER_PRIMARY_ID = '2';
    process.env.VOTER_A_ID = '3';
    process.env.VOTER_B_ID = '4';
    process.env.OFFICER_ID = '5';
    process.env.TEST_DB_PATH = './tmp.db';
    process.env.RAIDERIO_API_KEY = 'r';
    process.env.WOWAUDIT_API_KEY = 'w';
    const env = loadE2EEnv();
    expect(env.sandboxGuildId).toBe('1');
    expect(env.testDbPath).toBe('./tmp.db');
  });
});

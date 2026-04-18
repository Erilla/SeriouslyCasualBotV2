import { config as loadDotenv } from 'dotenv';

const REQUIRED_KEYS = [
  'DISCORD_TOKEN_TEST',
  'SANDBOX_GUILD_ID',
  'TESTER_PRIMARY_ID',
  'VOTER_A_ID',
  'VOTER_B_ID',
  'OFFICER_ID',
  'TEST_DB_PATH',
  'RAIDERIO_API_KEY',
  'WOWAUDIT_API_KEY',
] as const;

type Key = (typeof REQUIRED_KEYS)[number];

export interface E2EEnv {
  discordToken: string;
  sandboxGuildId: string;
  testerPrimaryId: string;
  voterAId: string;
  voterBId: string;
  officerId: string;
  testDbPath: string;
  raiderioApiKey: string;
  wowauditApiKey: string;
}

let cached: E2EEnv | null = null;

export function loadE2EEnv(): E2EEnv {
  if (cached) return cached;

  loadDotenv({ path: '.env.test' });

  const missing: Key[] = [];
  for (const key of REQUIRED_KEYS) {
    if (!process.env[key]) missing.push(key);
  }
  if (missing.length > 0) {
    throw new Error(`missing required e2e env vars: ${missing.join(', ')}`);
  }

  cached = {
    discordToken: process.env.DISCORD_TOKEN_TEST!,
    sandboxGuildId: process.env.SANDBOX_GUILD_ID!,
    testerPrimaryId: process.env.TESTER_PRIMARY_ID!,
    voterAId: process.env.VOTER_A_ID!,
    voterBId: process.env.VOTER_B_ID!,
    officerId: process.env.OFFICER_ID!,
    testDbPath: process.env.TEST_DB_PATH!,
    raiderioApiKey: process.env.RAIDERIO_API_KEY!,
    wowauditApiKey: process.env.WOWAUDIT_API_KEY!,
  };
  return cached;
}

export function resetE2EEnvCache(): void {
  cached = null;
}

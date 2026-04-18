import { config as loadDotenv } from 'dotenv';

const REQUIRED_KEYS = [
  'DISCORD_TOKEN',
  'GUILD_ID',
  'TESTER_PRIMARY_ID',
  'VOTER_A_ID',
  'VOTER_B_ID',
  'OFFICER_ID',
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
}

let cached: E2EEnv | null = null;

export function loadE2EEnv(options?: { skipDotenv?: boolean }): E2EEnv {
  if (cached) return cached;

  if (!options?.skipDotenv) {
    loadDotenv({ path: '.env' });
    loadDotenv({ path: '.env.test', override: true });
  }

  const missing: Key[] = [];
  for (const key of REQUIRED_KEYS) {
    if (!process.env[key]) missing.push(key);
  }
  if (missing.length > 0) {
    throw new Error(
      `missing required e2e env vars: ${missing.join(', ')}.\n` +
      `Copy .env.test.example → .env.test and fill in values.\n` +
      `See docs/superpowers/runbook/e2e-scaffold-setup.md`,
    );
  }

  cached = {
    discordToken: process.env.DISCORD_TOKEN!,
    sandboxGuildId: process.env.GUILD_ID!,
    testerPrimaryId: process.env.TESTER_PRIMARY_ID!,
    voterAId: process.env.VOTER_A_ID!,
    voterBId: process.env.VOTER_B_ID!,
    officerId: process.env.OFFICER_ID!,
    testDbPath: process.env.TEST_DB_PATH ?? './tests/e2e/.data/test.db',
  };
  return cached;
}

export function resetE2EEnvCache(): void {
  cached = null;
}

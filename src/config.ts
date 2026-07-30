import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, defaultValue: string): string {
  return process.env[name] || defaultValue;
}

function positiveFiniteNumber(name: string, value: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${name} must be a finite number greater than zero`);
  }
  return number;
}

export interface RaiderIoGuildIdentity {
  region: string;
  realm: string;
  name: string;
}

// The guild's Raider.IO identities: current (Silvermoon, Shadowlands onward)
// and pre-transfer (Darksorrow, Legion/BfA era). Overridable via the
// RAIDERIO_GUILDS env var (JSON array of {region, realm, name}).
const DEFAULT_RAIDERIO_GUILDS =
  '[{"region":"eu","realm":"silvermoon","name":"seriouslycasual"},' +
  '{"region":"eu","realm":"darksorrow","name":"seriously casual"}]';

export const config = {
  discordToken: required('DISCORD_TOKEN'),
  clientId: required('CLIENT_ID'),
  guildId: required('GUILD_ID'),
  officerRoleId: required('OFFICER_ROLE_ID'),
  wowAuditApiSecret: required('WOWAUDIT_API_SECRET'),
  warcraftLogsClientId: required('WARCRAFTLOGS_CLIENT_ID'),
  warcraftLogsClientSecret: required('WARCRAFTLOGS_CLIENT_SECRET'),
  warcraftLogsGuildId: required('WARCRAFTLOGS_GUILD_ID'),
  blizzardClientId: required('BLIZZARD_CLIENT_ID'),
  blizzardClientSecret: required('BLIZZARD_CLIENT_SECRET'),
  weeklyGearStaleHours: positiveFiniteNumber(
    'WEEKLY_GEAR_STALE_HOURS',
    optional('WEEKLY_GEAR_STALE_HOURS', '48'),
  ),
  raiderIoGuildIds: required('RAIDERIO_GUILD_IDS'),
  raiderIoGuilds: JSON.parse(
    optional('RAIDERIO_GUILDS', DEFAULT_RAIDERIO_GUILDS),
  ) as RaiderIoGuildIdentity[],
  // Optional: signup quip generator falls back to a static V1 corpus when unset.
  // Read lazily so tests that toggle the env var between cases see the change.
  get geminiApiKey() {
    return process.env.GEMINI_API_KEY ?? '';
  },
  // Optional: second/third quip-generator providers, tried after Gemini.
  // Read lazily so tests that toggle the env var between cases see the change.
  get openaiApiKey() {
    return process.env.OPENAI_API_KEY ?? '';
  },
  get anthropicApiKey() {
    return process.env.ANTHROPIC_API_KEY ?? '';
  },
  logLevel: optional('LOG_LEVEL', 'INFO') as 'DEBUG' | 'INFO' | 'WARN' | 'ERROR',
  nodeEnv: optional('NODE_ENV', 'development'),
  get isDevelopment() {
    return this.nodeEnv === 'development';
  },
  get isProduction() {
    return this.nodeEnv === 'production';
  },
} as const;

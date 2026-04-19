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

export const config = {
  discordToken: required('DISCORD_TOKEN'),
  clientId: required('CLIENT_ID'),
  guildId: required('GUILD_ID'),
  officerRoleId: required('OFFICER_ROLE_ID'),
  wowAuditApiSecret: required('WOWAUDIT_API_SECRET'),
  warcraftLogsClientId: required('WARCRAFTLOGS_CLIENT_ID'),
  warcraftLogsClientSecret: required('WARCRAFTLOGS_CLIENT_SECRET'),
  warcraftLogsGuildId: required('WARCRAFTLOGS_GUILD_ID'),
  raiderIoGuildIds: required('RAIDERIO_GUILD_IDS'),
  // Optional: signup quip generator falls back to a static V1 corpus when unset.
  // Read lazily so tests that toggle the env var between cases see the change.
  get geminiApiKey() {
    return process.env.GEMINI_API_KEY ?? '';
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

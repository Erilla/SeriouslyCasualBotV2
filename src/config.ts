import 'dotenv/config';

function required(key: string): string {
    const value = process.env[key];
    if (!value) {
        throw new Error(`Missing required environment variable: ${key}`);
    }
    return value;
}

function optional(key: string, defaultValue = ''): string {
    return process.env[key] ?? defaultValue;
}

export const config = {
    // Discord (required)
    token: required('DISCORD_TOKEN'),
    clientId: required('CLIENT_ID'),
    guildId: required('GUILD_ID'),

    // Redis
    redisUrl: optional('REDIS_URL', 'redis://localhost:6379'),

    // WarcraftLogs
    warcraftLogsClientId: optional('WARCRAFTLOGS_CLIENT_ID'),
    warcraftLogsClientSecret: optional('WARCRAFTLOGS_CLIENT_SECRET'),

    // WoW Audit
    wowAuditApiSecret: optional('WOWAUDIT_API_SECRET'),

    // EPGP
    epgpApiUrl: optional('EPGP_API_URL', 'https://epgp-api.ryanwong.uk'),

    // OpenAI
    openaiApiKey: optional('OPENAI_API_KEY'),

    // Logging
    logLevel: optional('LOG_LEVEL', 'INFO'),
} as const;

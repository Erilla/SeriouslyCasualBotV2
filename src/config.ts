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

    // Guild
    guildRegion: optional('GUILD_REGION', 'eu'),
    guildRealm: optional('GUILD_REALM', 'silvermoon'),
    guildName: optional('GUILD_NAME', 'seriouslycasual'),
    raiderioGuildId: optional('RAIDERIO_GUILD_ID', '1061585%2C43113'),

    // Logging
    logLevel: optional('LOG_LEVEL', 'INFO'),
} as const;

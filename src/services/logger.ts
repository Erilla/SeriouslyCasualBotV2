import {
    type Client,
    type TextChannel,
    ChannelType,
    EmbedBuilder,
    Colors,
    CategoryChannel,
    PermissionFlagsBits,
} from 'discord.js';
import { type LogLevel, LOG_LEVEL_ORDER } from '../types/index.js';

const LOG_COLORS: Record<LogLevel, number> = {
    DEBUG: Colors.Grey,
    INFO: Colors.Blue,
    WARN: Colors.Yellow,
    ERROR: Colors.Red,
    FATAL: Colors.DarkRed,
};

const LOG_CHANNEL_NAMES: Record<LogLevel, string> = {
    DEBUG: 'logs-debug',
    INFO: 'logs-info',
    WARN: 'logs-warn',
    ERROR: 'logs-error',
    FATAL: 'logs-fatal',
};

const LOGS_CATEGORY_NAME = 'Logs';

let client: Client | null = null;
let guildId: string | null = null;
let currentLogLevel: LogLevel = 'INFO';
let logChannels: Partial<Record<LogLevel, TextChannel>> = {};
let setupComplete = false;

function timestamp(): string {
    return new Date().toISOString();
}

function shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[currentLogLevel];
}

function consoleLog(level: LogLevel, message: string, error?: unknown): void {
    const ts = timestamp();
    const prefix = `[${ts}] [${level}]`;

    switch (level) {
        case 'DEBUG':
            console.debug(`${prefix} ${message}`);
            break;
        case 'INFO':
            console.info(`${prefix} ${message}`);
            break;
        case 'WARN':
            console.warn(`${prefix} ${message}`);
            break;
        case 'ERROR':
        case 'FATAL':
            console.error(`${prefix} ${message}`);
            if (error) console.error(error);
            break;
    }
}

async function discordLog(level: LogLevel, message: string, error?: unknown): Promise<void> {
    if (!setupComplete) return;

    const channel = logChannels[level];
    if (!channel) return;

    try {
        const embed = new EmbedBuilder()
            .setColor(LOG_COLORS[level])
            .setDescription(message.substring(0, 4000))
            .setTimestamp();

        if (error) {
            const errorStr = error instanceof Error
                ? `${error.message}\n${error.stack ?? ''}`
                : String(error);
            embed.addFields({ name: 'Error', value: errorStr.substring(0, 1024) });
        }

        await channel.send({ embeds: [embed] });
    } catch {
        // Silently fail - don't recurse if logging to Discord fails
    }
}

async function log(level: LogLevel, message: string, error?: unknown): Promise<void> {
    if (!shouldLog(level)) return;

    consoleLog(level, message, error);
    await discordLog(level, message, error);
}

export const logger = {
    /**
     * Initialize the logger with the Discord client and guild ID.
     * Call this once after the client is ready.
     */
    async init(discordClient: Client, guild: string): Promise<void> {
        client = discordClient;
        guildId = guild;
        await setupLogChannels();
    },

    setLevel(level: LogLevel): void {
        currentLogLevel = level;
    },

    getLevel(): LogLevel {
        return currentLogLevel;
    },

    async debug(message: string): Promise<void> {
        await log('DEBUG', message);
    },

    async info(message: string): Promise<void> {
        await log('INFO', message);
    },

    async warn(message: string): Promise<void> {
        await log('WARN', message);
    },

    async error(message: string, error?: unknown): Promise<void> {
        await log('ERROR', message, error);
    },

    async fatal(message: string, error?: unknown): Promise<void> {
        await log('FATAL', message, error);
    },
};

async function setupLogChannels(): Promise<void> {
    if (!client || !guildId) return;

    try {
        const guild = await client.guilds.fetch(guildId);

        // Find or create the Logs category
        let category = guild.channels.cache.find(
            (c) => c.type === ChannelType.GuildCategory && c.name === LOGS_CATEGORY_NAME
        ) as CategoryChannel | undefined;

        if (!category) {
            category = await guild.channels.create({
                name: LOGS_CATEGORY_NAME,
                type: ChannelType.GuildCategory,
                permissionOverwrites: [
                    {
                        id: guild.roles.everyone.id,
                        deny: [PermissionFlagsBits.ViewChannel],
                    },
                    {
                        id: client.user!.id,
                        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
                    },
                ],
            });
            consoleLog('INFO', `Created "${LOGS_CATEGORY_NAME}" category`);
        }

        // Find or create each log level channel
        for (const level of Object.keys(LOG_CHANNEL_NAMES) as LogLevel[]) {
            const channelName = LOG_CHANNEL_NAMES[level];

            let channel = guild.channels.cache.find(
                (c) => c.type === ChannelType.GuildText && c.name === channelName && c.parentId === category!.id
            ) as TextChannel | undefined;

            if (!channel) {
                channel = await guild.channels.create({
                    name: channelName,
                    type: ChannelType.GuildText,
                    parent: category.id,
                });
                consoleLog('INFO', `Created #${channelName} channel`);
            }

            logChannels[level] = channel;
        }

        setupComplete = true;
        consoleLog('INFO', 'Logger Discord channels ready');
    } catch (err) {
        consoleLog('ERROR', 'Failed to set up log channels', err);
    }
}

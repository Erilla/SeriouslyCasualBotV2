import {
    Client,
    Collection,
    GatewayIntentBits,
    Partials,
} from 'discord.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { config } from './config.js';
import type { BotClient, BotEvent, Command } from './types/index.js';
import { logger } from './services/logger.js';
import { initDatabase, closeDatabase } from './database/database.js';
import { closeScheduler } from './scheduler/scheduler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Create Discord Client ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
    ],
    partials: [
        Partials.Channel,
        Partials.Message,
    ],
}) as BotClient;

client.commands = new Collection();

// --- Load Commands ---
async function loadCommands(): Promise<void> {
    const commandsPath = path.join(__dirname, 'commands');
    if (!fs.existsSync(commandsPath)) return;

    const commandFiles = fs.readdirSync(commandsPath).filter(
        (f) => (f.endsWith('.js') || f.endsWith('.ts')) && !f.endsWith('.test.ts')
    );

    for (const file of commandFiles) {
        const filePath = path.join(commandsPath, file);
        const fileUrl = pathToFileURL(filePath).href;

        try {
            const mod = await import(fileUrl);
            const command = mod.default as Command;

            if (command?.data?.name) {
                if (command.testOnly && config.nodeEnv === 'production') {
                    console.log(`[INFO] Skipping test-only command: /${command.data.name}`);
                    continue;
                }
                client.commands.set(command.data.name, command);
            } else {
                console.warn(`[WARN] Command ${file}: missing data or name, skipping`);
            }
        } catch (error) {
            console.error(`[ERROR] Failed to load command ${file}:`, error);
        }
    }

    console.log(`[INFO] Loaded ${client.commands.size} commands`);
}

// --- Load Events ---
async function loadEvents(): Promise<void> {
    const eventsPath = path.join(__dirname, 'events');
    if (!fs.existsSync(eventsPath)) return;

    const eventFiles = fs.readdirSync(eventsPath).filter(
        (f) => (f.endsWith('.js') || f.endsWith('.ts')) && !f.endsWith('.test.ts')
    );

    for (const file of eventFiles) {
        const filePath = path.join(eventsPath, file);
        const fileUrl = pathToFileURL(filePath).href;

        try {
            const mod = await import(fileUrl);
            const event = mod.default as BotEvent;

            if (event?.name) {
                if (event.once) {
                    client.once(event.name, (...args) => event.execute(...args));
                } else {
                    client.on(event.name, (...args) => event.execute(...args));
                }
            } else {
                console.warn(`[WARN] Event ${file}: missing name, skipping`);
            }
        } catch (error) {
            console.error(`[ERROR] Failed to load event ${file}:`, error);
        }
    }

    console.log(`[INFO] Loaded ${eventFiles.length} event handlers`);
}

// --- Graceful Shutdown ---
function setupGracefulShutdown(): void {
    const shutdown = async (signal: string) => {
        console.log(`\n[INFO] Received ${signal}, shutting down gracefully...`);

        try {
            await logger.info(`Bot shutting down (${signal})`);
        } catch {
            // Logger may already be unavailable
        }

        await closeScheduler();
        closeDatabase();

        client.destroy();
        console.log('[INFO] Discord client destroyed');
        process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    process.on('unhandledRejection', async (error) => {
        console.error('[FATAL] Unhandled rejection:', error);
        try {
            await logger.fatal('Unhandled rejection', error);
        } catch {
            // Logger may be unavailable
        }
    });

    process.on('uncaughtException', async (error) => {
        console.error('[FATAL] Uncaught exception:', error);
        try {
            await logger.fatal('Uncaught exception', error);
        } catch {
            // Logger may be unavailable
        }
        process.exit(1);
    });
}

// --- Bootstrap ---
async function main(): Promise<void> {
    console.log('[INFO] Starting SeriouslyCasualBot V2...');

    setupGracefulShutdown();

    initDatabase();

    await loadCommands();
    await loadEvents();

    await client.login(config.token);
}

main().catch((error) => {
    console.error('[FATAL] Failed to start bot:', error);
    process.exit(1);
});

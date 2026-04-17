import { Client, Collection, GatewayIntentBits, Partials } from 'discord.js';
import { config } from './config.js';
import { initDatabase, closeDatabase } from './database/db.js';
import { initLogger, logger } from './services/logger.js';
import { scheduler } from './events/ready.js';
import { readdirSync } from 'fs';
import { pathToFileURL } from 'url';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { BotClient, BotEvent, Command } from './types/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Initialize ──────────────────────────────────────────────

initLogger(config.logLevel);
logger.info('bot', 'Starting SeriouslyCasualBot...');

initDatabase();
logger.info('bot', 'Database initialized');

// ─── Create Client ───────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
}) as BotClient;

client.commands = new Collection();

// ─── Load Commands ───────────────────────────────────────────

const commandsPath = join(__dirname, 'commands');
try {
  const commandFiles = readdirSync(commandsPath).filter((f) => f.endsWith('.js'));

  for (const file of commandFiles) {
    const filePath = join(commandsPath, file);
    const module = await import(pathToFileURL(filePath).href);
    const command = module.default as Command;

    if (!command?.data || !command?.execute) continue;
    if (command.devOnly && config.isProduction) continue;

    client.commands.set(command.data.name, command);
    logger.debug('bot', `Loaded command: ${command.data.name}`);
  }
} catch {
  logger.warn('bot', 'No commands directory found');
}

// ─── Load Events ─────────────────────────────────────────────

const eventsPath = join(__dirname, 'events');
const eventFiles = readdirSync(eventsPath).filter((f) => f.endsWith('.js'));

for (const file of eventFiles) {
  const filePath = join(eventsPath, file);
  const module = await import(pathToFileURL(filePath).href);
  const event = module.default as BotEvent;

  if (event.once) {
    client.once(event.name, (...args) => event.execute(...args));
  } else {
    client.on(event.name, (...args) => event.execute(...args));
  }
  logger.debug('bot', `Loaded event: ${event.name}`);
}

// ─── Graceful Shutdown ───────────────────────────────────────

async function shutdown(): Promise<void> {
  logger.info('bot', 'Shutting down...');
  scheduler.shutdown();
  client.destroy();
  closeDatabase();
  logger.info('bot', 'Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ─── Login ───────────────────────────────────────────────────

await client.login(config.discordToken);

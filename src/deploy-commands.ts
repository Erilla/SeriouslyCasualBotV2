import { REST, Routes } from 'discord.js';
import { config } from './config.js';
import { readdirSync } from 'fs';
import { pathToFileURL } from 'url';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { Command } from './types/index.js';
import { logger } from './services/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function deployCommands(): Promise<void> {
  const commands: unknown[] = [];
  const commandsPath = join(__dirname, 'commands');

  let commandFiles: string[];
  try {
    commandFiles = readdirSync(commandsPath).filter((f) => f.endsWith('.js') || f.endsWith('.ts'));
  } catch {
    logger.warn('deploy', 'No commands directory found, skipping command registration');
    return;
  }

  for (const file of commandFiles) {
    const filePath = join(commandsPath, file);
    const module = await import(pathToFileURL(filePath).href);
    const command = module.default as Command;

    if (!command?.data || !command?.execute) continue;
    if (command.devOnly && config.isProduction) continue;

    commands.push(command.data.toJSON());
  }

  const rest = new REST().setToken(config.discordToken);

  logger.info('deploy', `Registering ${commands.length} commands to guild ${config.guildId}`);

  await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), {
    body: commands,
  });

  logger.info('deploy', 'Commands registered successfully');
}

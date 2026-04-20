import { readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { logger } from './services/logger.js';
import type { BotClient, Command } from './types/index.js';

/**
 * Discovers command modules under src/commands/ and registers them on
 * client.commands. Callers (main entry + e2e bootstrap) pass options that
 * control the runtime filtering (dev-only commands in production, etc.).
 */
export async function loadCommands(
  client: BotClient,
  options: { skipDevOnly?: boolean } = {},
): Promise<void> {
  const { skipDevOnly = false } = options;
  const here = dirname(fileURLToPath(import.meta.url));
  const commandsPath = join(here, 'commands');

  let files: string[];
  try {
    files = readdirSync(commandsPath).filter((f) => f.endsWith('.ts') || f.endsWith('.js'));
  } catch {
    logger.warn('bot', 'No commands directory found');
    return;
  }

  for (const file of files) {
    try {
      const mod = await import(pathToFileURL(join(commandsPath, file)).href);
      const cmd = mod.default as Command | undefined;

      if (!cmd?.data || !cmd?.execute) {
        logger.warn('bot', `Skipping ${file}: missing data or execute`);
        continue;
      }
      if (skipDevOnly && cmd.devOnly) continue;

      client.commands.set(cmd.data.name, cmd);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('bot', `Failed to load command ${file}: ${err.message}`, err);
    }
  }
}

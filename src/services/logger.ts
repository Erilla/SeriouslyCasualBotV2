import type { TextChannel } from 'discord.js';
import type { LogLevel } from '../types/index.js';

const LOG_LEVELS: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

export class Logger {
  private level: LogLevel;
  private discordChannel: TextChannel | null = null;

  constructor(level: LogLevel = 'INFO') {
    this.level = level;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  setDiscordChannel(channel: TextChannel): void {
    this.discordChannel = channel;
  }

  debug(domain: string, message: string): void {
    this.log('DEBUG', domain, message);
  }

  info(domain: string, message: string): void {
    this.log('INFO', domain, message);
  }

  warn(domain: string, message: string): void {
    this.log('WARN', domain, message);
  }

  error(domain: string, message: string, error?: Error): void {
    if (LOG_LEVELS[this.level] <= LOG_LEVELS.ERROR) {
      const timestamp = new Date().toISOString();
      const formatted = `${timestamp} [ERROR] [${domain}] ${message}`;
      console.error(formatted);
      if (error?.stack) {
        console.error(error.stack);
      }
      this.sendToDiscord(formatted).catch(() => {});
    }
  }

  private log(level: LogLevel, domain: string, message: string): void {
    if (LOG_LEVELS[this.level] > LOG_LEVELS[level]) return;

    const timestamp = new Date().toISOString();
    const formatted = `${timestamp} [${level}] [${domain}] ${message}`;

    if (level === 'WARN') {
      console.warn(formatted);
    } else {
      console.log(formatted);
    }

    if (LOG_LEVELS[level] >= LOG_LEVELS.INFO) {
      this.sendToDiscord(formatted).catch(() => {});
    }
  }

  private async sendToDiscord(message: string): Promise<void> {
    if (!this.discordChannel) return;
    try {
      await this.discordChannel.send({ content: `\`\`\`\n${message}\n\`\`\`` });
    } catch {
      // Silently fail - don't recurse if Discord logging fails
    }
  }
}

export let logger = new Logger('INFO');

export function initLogger(level: LogLevel): void {
  logger = new Logger(level);
}

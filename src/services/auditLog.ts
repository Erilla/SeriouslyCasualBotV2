import type { TextChannel, User } from 'discord.js';
import { logger } from './logger.js';

let auditChannel: TextChannel | null = null;

export function setAuditChannel(channel: TextChannel): void {
  auditChannel = channel;
}

export async function audit(officer: User, action: string, detail: string): Promise<void> {
  const message = `**${officer.displayName}** ${action}: ${detail}`;
  logger.info('audit', message);

  if (!auditChannel) return;

  try {
    await auditChannel.send({ content: message });
  } catch {
    logger.error('audit', 'Failed to send audit log to Discord');
  }
}

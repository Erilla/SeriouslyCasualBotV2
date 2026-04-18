import type { TextChannel, User } from 'discord.js';
import { logger } from './logger.js';
import { getDatabase } from '../database/db.js';

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

/**
 * Post an officer-visible alert to the audit channel, pinging the configured
 * officer role so someone actually sees it. Used for background/autonomous
 * failures that would otherwise only surface in stdout (see #42).
 *
 * Falls back to logging only if the audit channel or role is not configured —
 * the alert must never throw back into the caller's error path.
 */
export async function alertOfficers(title: string, detail: string): Promise<void> {
  const logLine = `${title}: ${detail}`;
  logger.warn('audit', logLine);

  if (!auditChannel) return;

  const row = getDatabase()
    .prepare('SELECT value FROM config WHERE key = ?')
    .get('officer_role_id') as { value: string } | undefined;

  const mention = row ? `<@&${row.value}> ` : '';
  const content = `${mention}**${title}**\n${detail}`;

  try {
    await auditChannel.send({
      content,
      allowedMentions: row ? { roles: [row.value] } : { parse: [] },
    });
  } catch (err) {
    logger.error(
      'audit',
      `Failed to post officer alert to Discord: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

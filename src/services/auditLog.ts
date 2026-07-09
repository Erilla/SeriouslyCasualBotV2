import type { TextChannel, User } from 'discord.js';
import { logger } from './logger.js';
import { config } from '../config.js';

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
 * Post an officer-visible alert to the audit channel, pinging the officer role
 * so someone actually sees it. Used for background/autonomous failures that
 * would otherwise only surface in stdout (see #42).
 *
 * The officer role is the single source of truth from OFFICER_ROLE_ID (the same
 * role that gates officer commands), not a separate /setup value — so the ping
 * can never target a different role than the permission checks.
 *
 * Falls back to logging only if the audit channel is not configured — the alert
 * must never throw back into the caller's error path.
 */
export async function alertOfficers(title: string, detail: string): Promise<void> {
  const logLine = `${title}: ${detail}`;
  logger.warn('audit', logLine);

  if (!auditChannel) return;

  // Callers fire-and-forget this with `void`, so any throw from the Discord
  // call becomes an unhandled rejection. The entire function must be
  // non-throwing — log and swallow.
  try {
    const roleId = config.officerRoleId;
    const content = `<@&${roleId}> **${title}**\n${detail}`;

    await auditChannel.send({
      content,
      allowedMentions: { roles: [roleId] },
    });
  } catch (err) {
    logger.error(
      'audit',
      `Failed to post officer alert to Discord: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

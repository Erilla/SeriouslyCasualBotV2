/**
 * Create and update the 3-message EPGP display in a Discord channel.
 */

import type { Client, TextChannel } from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { asSendable } from '../../utils.js';
import { logger } from '../../services/logger.js';
import { generateDisplay } from './generateDisplay.js';
import type { EpgpConfigRow } from '../../types/index.js';

function getEpgpConfig(key: string): string | null {
  const db = getDatabase();
  const row = db
    .prepare('SELECT value FROM epgp_config WHERE key = ?')
    .get(key) as EpgpConfigRow | undefined;
  return row?.value ?? null;
}

function setEpgpConfig(key: string, value: string): void {
  const db = getDatabase();
  db.prepare('INSERT OR REPLACE INTO epgp_config (key, value) VALUES (?, ?)').run(key, value);
}

/** Remove the legacy single body_message_id key if it exists (replaced by body_message_ids JSON array). */
function cleanupLegacyBodyKey(): void {
  const db = getDatabase();
  db.prepare("DELETE FROM epgp_config WHERE key = 'body_message_id'").run();
}

async function getEpgpChannel(client: Client): Promise<TextChannel | null> {
  const db = getDatabase();
  const channelConfig = db
    .prepare("SELECT value FROM config WHERE key = 'epgp_rankings_channel_id'")
    .get() as { value: string } | undefined;

  if (!channelConfig) {
    logger.warn('EPGP', 'No epgp_rankings_channel_id configured. Use /setup set_channel.');
    return null;
  }

  try {
    const channel = await client.channels.fetch(channelConfig.value);
    return asSendable(channel);
  } catch {
    logger.error('EPGP', `Failed to fetch EPGP channel: ${channelConfig.value}`);
    return null;
  }
}

export async function createDisplayPost(client: Client): Promise<void> {
  const channel = await getEpgpChannel(client);
  if (!channel) {
    throw new Error('EPGP channel not configured or not accessible.');
  }

  const { header, bodies, footer } = generateDisplay();

  const headerMsg = await channel.send(header);
  setEpgpConfig('header_message_id', headerMsg.id);

  const bodyIds: string[] = [];
  for (const bodyContent of bodies) {
    const msg = await channel.send(bodyContent);
    bodyIds.push(msg.id);
  }
  setEpgpConfig('body_message_ids', JSON.stringify(bodyIds));

  const footerMsg = await channel.send(footer);
  setEpgpConfig('footer_message_id', footerMsg.id);

  cleanupLegacyBodyKey();

  logger.info('EPGP', `Created EPGP display post (${bodies.length} body message(s)).`);
}

export async function updateDisplayPost(client: Client): Promise<void> {
  const channel = await getEpgpChannel(client);
  if (!channel) {
    throw new Error('EPGP channel not configured or not accessible.');
  }

  const headerMsgId = getEpgpConfig('header_message_id');
  const bodyMsgIdsJson = getEpgpConfig('body_message_ids');
  const legacyBodyMsgId = getEpgpConfig('body_message_id');
  const footerMsgId = getEpgpConfig('footer_message_id');

  // Migrate from legacy single body_message_id if needed
  const existingBodyIds: string[] = bodyMsgIdsJson
    ? JSON.parse(bodyMsgIdsJson) as string[]
    : legacyBodyMsgId
      ? [legacyBodyMsgId]
      : [];

  if (!headerMsgId || existingBodyIds.length === 0 || !footerMsgId) {
    logger.warn('EPGP', 'No existing display post found. Creating new one.');
    await createDisplayPost(client);
    return;
  }

  const { header, bodies, footer } = generateDisplay();

  // Update header
  try {
    const headerMsg = await channel.messages.fetch(headerMsgId);
    await headerMsg.edit(header);
  } catch {
    logger.warn('EPGP', 'Could not edit header message. It may have been deleted.');
  }

  // Update body messages: edit existing, add new if needed, delete extras
  const newBodyIds: string[] = [];

  for (let i = 0; i < bodies.length; i++) {
    if (i < existingBodyIds.length) {
      // Edit existing body message
      try {
        const msg = await channel.messages.fetch(existingBodyIds[i]);
        await msg.edit(bodies[i]);
        newBodyIds.push(existingBodyIds[i]);
      } catch {
        // Message deleted - send a new one
        const msg = await channel.send(bodies[i]);
        newBodyIds.push(msg.id);
      }
    } else {
      // Need a new body message (content grew)
      const msg = await channel.send(bodies[i]);
      newBodyIds.push(msg.id);
    }
  }

  // Delete extra body messages if content shrunk
  for (let i = bodies.length; i < existingBodyIds.length; i++) {
    try {
      const msg = await channel.messages.fetch(existingBodyIds[i]);
      await msg.delete();
    } catch {
      // Already gone
    }
  }

  setEpgpConfig('body_message_ids', JSON.stringify(newBodyIds));

  if (legacyBodyMsgId) cleanupLegacyBodyKey();

  // Update footer
  try {
    const footerMsg = await channel.messages.fetch(footerMsgId);
    await footerMsg.edit(footer);
  } catch {
    logger.warn('EPGP', 'Could not edit footer message. It may have been deleted.');
  }

  logger.info('EPGP', `Updated EPGP display post (${bodies.length} body message(s)).`);
}

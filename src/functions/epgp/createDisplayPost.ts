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

async function getEpgpChannel(client: Client): Promise<TextChannel | null> {
  const db = getDatabase();
  const channelConfig = db
    .prepare("SELECT value FROM config WHERE key = 'epgp_channel_id'")
    .get() as { value: string } | undefined;

  if (!channelConfig) {
    logger.warn('EPGP', 'No epgp_channel_id configured. Use /setup set_channel.');
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

  const [header, body, footer] = generateDisplay();

  const headerMsg = await channel.send(header);
  const bodyMsg = await channel.send(body);
  const footerMsg = await channel.send(footer);

  setEpgpConfig('header_message_id', headerMsg.id);
  setEpgpConfig('body_message_id', bodyMsg.id);
  setEpgpConfig('footer_message_id', footerMsg.id);

  logger.info('EPGP', 'Created EPGP display post.');
}

export async function updateDisplayPost(client: Client): Promise<void> {
  const channel = await getEpgpChannel(client);
  if (!channel) {
    throw new Error('EPGP channel not configured or not accessible.');
  }

  const headerMsgId = getEpgpConfig('header_message_id');
  const bodyMsgId = getEpgpConfig('body_message_id');
  const footerMsgId = getEpgpConfig('footer_message_id');

  if (!headerMsgId || !bodyMsgId || !footerMsgId) {
    logger.warn('EPGP', 'No existing display post found. Creating new one.');
    await createDisplayPost(client);
    return;
  }

  const [header, body, footer] = generateDisplay();

  try {
    const headerMsg = await channel.messages.fetch(headerMsgId);
    await headerMsg.edit(header);
  } catch {
    logger.warn('EPGP', 'Could not edit header message. It may have been deleted.');
  }

  try {
    const bodyMsg = await channel.messages.fetch(bodyMsgId);
    await bodyMsg.edit(body);
  } catch {
    logger.warn('EPGP', 'Could not edit body message. It may have been deleted.');
  }

  try {
    const footerMsg = await channel.messages.fetch(footerMsgId);
    await footerMsg.edit(footer);
  } catch {
    logger.warn('EPGP', 'Could not edit footer message. It may have been deleted.');
  }

  logger.info('EPGP', 'Updated EPGP display post.');
}

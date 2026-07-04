import type { TextChannel } from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';
import { generateLootPost } from './generateLootPost.js';

export interface Boss {
  id: number;
  name: string;
  url?: string;
}

export async function addLootPost(channel: TextChannel, boss: Boss): Promise<void> {
  const postData = generateLootPost(boss.name, boss.id, {
    major: '*None*',
    minor: '*None*',
    wantIn: '*None*',
    wantOut: '*None*',
  });

  const message = await channel.send(postData);

  const db = getDatabase();
  db.prepare(
    'INSERT INTO loot_posts (boss_id, boss_name, boss_url, channel_id, message_id) VALUES (?, ?, ?, ?, ?)',
  ).run(boss.id, boss.name, boss.url ?? null, channel.id, message.id);

  // debug, not info: addLootPost is only ever called in bulk loops (tier setup,
  // migrate, test seed), each of which logs its own summary. A per-post info log
  // mirrors to Discord and floods the log channel with one message per boss.
  logger.debug('Loot', `Created loot post for boss "${boss.name}" (id=${boss.id}) in channel ${channel.id}`);
}

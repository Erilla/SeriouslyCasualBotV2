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
  const db = getDatabase();
  const postData = generateLootPost(boss.name, boss.id, {
    major: '*None*',
    minor: '*None*',
    wantIn: '*None*',
    wantOut: '*None*',
  });

  const existing = db
    .prepare('SELECT message_id FROM loot_posts WHERE boss_id = ?')
    .get(boss.id) as { message_id: string } | undefined;
  if (existing) {
    try {
      await channel.messages.fetch(existing.message_id);
      logger.debug('Loot', `Keeping existing loot post for boss "${boss.name}" (id=${boss.id})`);
      return;
    } catch {
      const message = await channel.send(postData);
      db.prepare('UPDATE loot_posts SET channel_id = ?, message_id = ? WHERE boss_id = ?').run(
        channel.id,
        message.id,
        boss.id,
      );
      logger.debug('Loot', `Recreated missing loot post for boss "${boss.name}" (id=${boss.id})`);
      return;
    }
  }

  const message = await channel.send(postData);

  db.prepare(
    'INSERT INTO loot_posts (boss_id, boss_name, boss_url, channel_id, message_id) VALUES (?, ?, ?, ?, ?)',
  ).run(boss.id, boss.name, boss.url ?? null, channel.id, message.id);

  // debug, not info: addLootPost is only ever called in bulk loops (tier setup,
  // migrate, test seed), each of which logs its own summary. A per-post info log
  // mirrors to Discord and floods the log channel with one message per boss.
  logger.debug(
    'Loot',
    `Created loot post for boss "${boss.name}" (id=${boss.id}) in channel ${channel.id}`,
  );
}

import type { ThreadChannel } from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';
import type { OverlordRow } from '../../types/index.js';

export function addOverlord(name: string, userId: string): void {
  const db = getDatabase();
  db.prepare('INSERT INTO overlords (name, user_id) VALUES (?, ?)').run(name, userId);
  logger.info('Overlords', `Added overlord "${name}" (${userId})`);
}

export function removeOverlord(name: string): void {
  const db = getDatabase();
  db.prepare('DELETE FROM overlords WHERE name = ?').run(name);
  logger.info('Overlords', `Removed overlord "${name}"`);
}

export function getOverlords(): OverlordRow[] {
  const db = getDatabase();
  return db.prepare('SELECT * FROM overlords').all() as OverlordRow[];
}

export async function addOverlordsToThread(thread: ThreadChannel): Promise<void> {
  const overlords = getOverlords();

  for (const overlord of overlords) {
    try {
      await thread.members.add(overlord.user_id);
    } catch (error) {
      logger.error(
        'Overlords',
        `Failed to add overlord "${overlord.name}" (${overlord.user_id}) to thread ${thread.id}`,
        error as Error,
      );
    }
  }

  logger.info('Overlords', `Added ${overlords.length} overlords to thread ${thread.id}`);
}

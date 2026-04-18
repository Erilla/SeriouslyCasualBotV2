import { existsSync, mkdirSync, readdirSync, unlinkSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';

/** Absolute path to backup directory, anchored to cwd at import time. */
const BACKUP_DIR = resolve(process.cwd(), 'backups');
const MAX_BACKUPS = 7;

export async function dailyBackup(): Promise<void> {
  if (!existsSync(BACKUP_DIR)) {
    mkdirSync(BACKUP_DIR, { recursive: true });
  }

  const date = new Date().toISOString().split('T')[0];
  const filename = `db-${date}.sqlite`;
  const filepath = join(BACKUP_DIR, filename);

  try {
    const db = getDatabase();
    await db.backup(filepath);

    const size = statSync(filepath).size;
    const sizeMB = (size / 1024 / 1024).toFixed(2);
    logger.info('Backup', `Daily backup complete: ${filename} (${sizeMB} MB)`);
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('Backup', `Daily backup failed: ${err.message}`, err);
    return;
  }

  // Clean up old backups
  try {
    const files = readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith('db-') && f.endsWith('.sqlite'))
      .sort()
      .reverse();

    const toDelete = files.slice(MAX_BACKUPS);
    for (const file of toDelete) {
      unlinkSync(join(BACKUP_DIR, file));
      logger.debug('Backup', `Deleted old backup: ${file}`);
    }

    if (toDelete.length > 0) {
      logger.info('Backup', `Cleaned up ${toDelete.length} old backups`);
    }
  } catch (error) {
    logger.warn('Backup', `Failed to clean old backups: ${error}`);
  }
}

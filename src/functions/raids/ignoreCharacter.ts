import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';

export function ignoreCharacter(characterName: string): boolean {
  const db = getDatabase();

  try {
    db.transaction(() => {
      db.prepare('INSERT OR IGNORE INTO ignored_characters (character_name) VALUES (?)').run(
        characterName,
      );
      db.prepare('DELETE FROM raiders WHERE character_name = ?').run(characterName);
    })();

    logger.info('IgnoreCharacter', `Ignored and removed raider "${characterName}"`);
    return true;
  } catch (error) {
    logger.error('IgnoreCharacter', `Failed to ignore "${characterName}"`, error as Error);
    return false;
  }
}

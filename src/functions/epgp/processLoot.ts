/**
 * Process EPGP loot entries: match to raiders, check duplicates, store loot history.
 */

import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';
import type { RaiderRow } from '../../types/index.js';
import type { EpgpLootEntry } from './parseEpgpUpload.js';

/**
 * Extract item ID from an item string.
 * Item strings are in the format "item:12345:..." - we extract the numeric ID.
 */
function extractItemId(itemString: string): string | null {
  const match = itemString.match(/item:(\d+)/);
  return match ? match[1] : null;
}

export function processLoot(lootEntries: EpgpLootEntry[]): { inserted: number; duplicates: number; skipped: number } {
  logger.debug('EPGP', `Processing ${lootEntries.length} loot entries`);
  const db = getDatabase();

  const findRaider = db.prepare(
    'SELECT * FROM raiders WHERE LOWER(character_name) = LOWER(?) AND LOWER(realm) = LOWER(?)',
  );
  const checkDuplicate = db.prepare(
    `SELECT id FROM epgp_loot_history
     WHERE raider_id = ? AND item_string = ? AND gear_points = ? AND DATE(looted_at) = DATE(?)`,
  );
  const insertLoot = db.prepare(
    `INSERT INTO epgp_loot_history (raider_id, item_id, item_string, gear_points, looted_at)
     VALUES (?, ?, ?, ?, ?)`,
  );

  let inserted = 0;
  let duplicates = 0;
  let skipped = 0;

  const transaction = db.transaction(() => {
    for (const entry of lootEntries) {
      const raider = findRaider.get(entry.characterName, entry.realm) as RaiderRow | undefined;

      if (!raider) {
        logger.debug('EPGP', `Loot entry skipped: raider not found for ${entry.characterName}-${entry.realm}`);
        skipped++;
        continue;
      }

      const lootedAt = new Date(entry.timestamp * 1000).toISOString();
      const itemId = extractItemId(entry.itemString);

      const existing = checkDuplicate.get(raider.id, entry.itemString, entry.gp, lootedAt);

      if (existing) {
        duplicates++;
        continue;
      }

      insertLoot.run(raider.id, itemId, entry.itemString, entry.gp, lootedAt);
      inserted++;
    }
  });

  transaction();

  logger.info('EPGP', `Loot processing complete: ${inserted} inserted, ${duplicates} duplicates, ${skipped} skipped`);
  return { inserted, duplicates, skipped };
}

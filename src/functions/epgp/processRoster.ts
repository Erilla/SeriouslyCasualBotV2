/**
 * Process EPGP roster entries: match to existing raiders, store EP/GP snapshots.
 */

import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';
import type { RaiderRow } from '../../types/index.js';
import type { EpgpRosterEntry } from './parseEpgpUpload.js';

const BASE_URL = 'https://raider.io/api/v1';

async function fetchCharacterClass(
  region: string,
  realm: string,
  name: string,
): Promise<string | null> {
  try {
    const url = `${BASE_URL}/characters/profile?region=${region}&realm=${realm}&name=${encodeURIComponent(name)}`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = (await response.json()) as { class: string };
    return data.class ?? null;
  } catch {
    return null;
  }
}

export async function processRoster(
  roster: EpgpRosterEntry[],
  region: string,
): Promise<{ processed: number; skipped: number }> {
  const db = getDatabase();
  const now = new Date().toISOString();

  const findRaider = db.prepare(
    'SELECT * FROM raiders WHERE LOWER(character_name) = LOWER(?) AND LOWER(realm) = LOWER(?)',
  );
  const insertEP = db.prepare(
    'INSERT INTO epgp_effort_points (raider_id, points, timestamp) VALUES (?, ?, ?)',
  );
  const insertGP = db.prepare(
    'INSERT INTO epgp_gear_points (raider_id, points, timestamp) VALUES (?, ?, ?)',
  );
  const updateClass = db.prepare('UPDATE raiders SET class = ? WHERE id = ?');

  let processed = 0;
  let skipped = 0;
  const classUpdates: Array<{ raiderId: number; region: string; realm: string; name: string }> = [];

  const insertPoints = db.transaction(() => {
    for (const entry of roster) {
      if (entry.ep <= 0) {
        skipped++;
        continue;
      }

      const raider = findRaider.get(entry.characterName, entry.realm) as RaiderRow | undefined;

      if (!raider) {
        skipped++;
        continue;
      }

      if (!raider.class) {
        classUpdates.push({
          raiderId: raider.id,
          region: region.toLowerCase(),
          realm: entry.realm.toLowerCase(),
          name: entry.characterName,
        });
      }

      insertEP.run(raider.id, entry.ep, now);
      insertGP.run(raider.id, entry.gp, now);
      processed++;
    }
  });

  insertPoints();

  // Fetch classes outside the transaction (non-critical, async)
  for (const update of classUpdates) {
    try {
      const charClass = await fetchCharacterClass(update.region, update.realm, update.name);
      if (charClass) {
        updateClass.run(charClass, update.raiderId);
        logger.debug('EPGP', `Updated class for ${update.name}: ${charClass}`);
      }
    } catch {
      // Non-critical, skip
    }
  }

  return { processed, skipped };
}

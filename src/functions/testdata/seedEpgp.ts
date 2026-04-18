import type Database from 'better-sqlite3';

export interface SeedEpgpResult {
  raiderCount: number;
  effortPointsInserted: number;
  gearPointsInserted: number;
  lootHistoryInserted: number;
  uploadHistoryInserted: number;
}

const MOCK_ITEMS = [
  { item_id: '212001', item_string: 'item:212001::::::::80::::', gear_points: 150 },
  { item_id: '212002', item_string: 'item:212002::::::::80::::', gear_points: 200 },
  { item_id: '212003', item_string: 'item:212003::::::::80::::', gear_points: 100 },
  { item_id: '212004', item_string: 'item:212004::::::::80::::', gear_points: 175 },
  { item_id: '212005', item_string: 'item:212005::::::::80::::', gear_points: 225 },
];

/**
 * Seeds EPGP data for existing raiders.
 * Throws if no raiders are found (run seed_raiders first).
 * Inserts 3 EP entries per raider (over 3 weeks), GP for a subset, and
 * 5 loot history entries spread across raiders.
 */
export function seedEpgp(db: Database.Database): SeedEpgpResult {
  const raiders = db.prepare('SELECT id, character_name FROM raiders').all() as Array<{ id: number; character_name: string }>;

  if (raiders.length === 0) {
    throw new Error('No raiders found. Run seed_raiders first.');
  }

  const tx = db.transaction((): SeedEpgpResult => {
    const insertEP = db.prepare('INSERT INTO epgp_effort_points (raider_id, points, timestamp) VALUES (?, ?, ?)');
    const insertGP = db.prepare('INSERT INTO epgp_gear_points (raider_id, points, timestamp) VALUES (?, ?, ?)');
    const insertLoot = db.prepare('INSERT INTO epgp_loot_history (raider_id, item_id, item_string, gear_points, looted_at) VALUES (?, ?, ?, ?, ?)');

    let epCount = 0;
    let gpCount = 0;

    // 3 EP entries per raider, one per week going back
    for (let idx = 0; idx < raiders.length; idx++) {
      const raider = raiders[idx];
      for (let week = 0; week < 3; week++) {
        const weeksAgo = week + 1;
        const ts = new Date();
        ts.setUTCDate(ts.getUTCDate() - weeksAgo * 7);
        const timestamp = ts.toISOString().replace('T', ' ').slice(0, 19);
        insertEP.run(raider.id, 100 + (week * 25), timestamp);
        epCount++;
      }

      // GP entries for first half of raiders only (simulates varied loot history)
      if (idx < Math.ceil(raiders.length / 2)) {
        const ts = new Date();
        ts.setUTCDate(ts.getUTCDate() - 14);
        const timestamp = ts.toISOString().replace('T', ' ').slice(0, 19);
        insertGP.run(raider.id, 150 + (idx * 10), timestamp);
        gpCount++;
      }
    }

    // 5 loot history entries spread across first 5 raiders (or fewer if less raiders)
    let lootCount = 0;
    const lootRaiders = raiders.slice(0, 5);
    for (let i = 0; i < lootRaiders.length; i++) {
      const item = MOCK_ITEMS[i % MOCK_ITEMS.length];
      const ts = new Date();
      ts.setUTCDate(ts.getUTCDate() - (i + 1) * 3);
      const lootedAt = ts.toISOString().replace('T', ' ').slice(0, 19);
      insertLoot.run(lootRaiders[i].id, item.item_id, item.item_string, item.gear_points, lootedAt);
      lootCount++;
    }

    // 1 upload history record
    db.prepare(`
      INSERT INTO epgp_upload_history (timestamp, decay_percent, uploaded_content)
      VALUES (datetime('now', '-7 days'), 10, 'Mock EPGP upload content for testing')
    `).run();

    return {
      raiderCount: raiders.length,
      effortPointsInserted: epCount,
      gearPointsInserted: gpCount,
      lootHistoryInserted: lootCount,
      uploadHistoryInserted: 1,
    };
  });

  return tx();
}

/**
 * EPGP point calculation: priority, decay, cutoff dates, and filtering.
 */

import { getDatabase } from '../../database/db.js';
import type { RaiderRow, EpgpUploadHistoryRow } from '../../types/index.js';

// ─── Class Mappings ─────────────────────────────────────────

const TIER_TOKEN_CLASSES: Record<string, string[]> = {
  Zenith: ['Evoker', 'Monk', 'Rogue', 'Warrior'],
  Dreadful: ['Death Knight', 'Demon Hunter', 'Warlock'],
  Mystic: ['Druid', 'Hunter', 'Mage'],
  Venerated: ['Paladin', 'Priest', 'Shaman'],
};

const ARMOUR_TYPE_CLASSES: Record<string, string[]> = {
  Cloth: ['Mage', 'Priest', 'Warlock'],
  Leather: ['Demon Hunter', 'Druid', 'Monk', 'Rogue'],
  Mail: ['Evoker', 'Hunter', 'Shaman'],
  Plate: ['Death Knight', 'Paladin', 'Warrior'],
};

// ─── Types ──────────────────────────────────────────────────

export interface EpgpRaiderPoints {
  characterName: string;
  ep: number;
  gp: number;
  priority: number;
  epDiff: number;
  gpDiff: number;
}

export interface EpgpAllPointsResult {
  lastUploadedDate: string | null;
  cutoffDate: string;
  raiders: EpgpRaiderPoints[];
}

// ─── Cutoff Date ────────────────────────────────────────────

export function calculateCutoffDate(now?: Date): Date {
  const d = now ?? new Date();
  const day = d.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const hour = d.getUTCHours();
  const cutoffHour = 18; // 6PM UTC

  let cutoffDay: number;

  if (day === 0) {
    // Sunday
    cutoffDay = hour < cutoffHour ? 3 : 0; // Wed or Sun
  } else if (day <= 2) {
    // Mon, Tue
    cutoffDay = 0; // Previous Sunday
  } else if (day === 3) {
    // Wednesday
    cutoffDay = hour < cutoffHour ? 0 : 3; // Sun or Wed
  } else {
    // Thu, Fri, Sat
    cutoffDay = 3; // Wednesday
  }

  // Calculate previous occurrence of cutoffDay
  let daysBack = (day - cutoffDay + 7) % 7;
  if (daysBack === 0 && hour >= cutoffHour) daysBack = 0;
  else if (daysBack === 0) daysBack = 7;

  const cutoff = new Date(d);
  cutoff.setUTCDate(cutoff.getUTCDate() - daysBack);
  cutoff.setUTCHours(cutoffHour, 0, 0, 0);
  return cutoff;
}

// ─── Main Calculation ───────────────────────────────────────

export function getAllPoints(
  tierToken?: string | null,
  armourType?: string | null,
): EpgpAllPointsResult {
  const db = getDatabase();

  // Get all active raiders (those with EP > 0 at some point)
  let raiders = db
    .prepare(
      `SELECT DISTINCT r.* FROM raiders r
       INNER JOIN epgp_effort_points ep ON ep.raider_id = r.id`,
    )
    .all() as RaiderRow[];

  // Filter by tier token
  if (tierToken) {
    const allowedClasses = TIER_TOKEN_CLASSES[tierToken];
    if (allowedClasses) {
      raiders = raiders.filter((r) => r.class && allowedClasses.includes(r.class));
    }
  }

  // Filter by armour type
  if (armourType) {
    const allowedClasses = ARMOUR_TYPE_CLASSES[armourType];
    if (allowedClasses) {
      raiders = raiders.filter((r) => r.class && allowedClasses.includes(r.class));
    }
  }

  // Get last upload
  const lastUpload = db
    .prepare('SELECT * FROM epgp_upload_history ORDER BY timestamp DESC LIMIT 1')
    .get() as EpgpUploadHistoryRow | undefined;

  const lastUploadedDate = lastUpload?.timestamp ?? null;
  const lastUploadDate = lastUploadedDate ? new Date(lastUploadedDate) : null;
  const decayPercent = lastUpload?.decay_percent ?? 0;
  const decayMultiplier = decayPercent / 100;

  const cutoffDate = calculateCutoffDate();
  const cutoffIso = cutoffDate.toISOString();

  // Prepared statements for lookups
  const getLatestEP = db.prepare(
    'SELECT points FROM epgp_effort_points WHERE raider_id = ? ORDER BY timestamp DESC LIMIT 1',
  );
  const getLatestGP = db.prepare(
    'SELECT points FROM epgp_gear_points WHERE raider_id = ? ORDER BY timestamp DESC LIMIT 1',
  );
  const getPreCutoffEP = db.prepare(
    'SELECT points FROM epgp_effort_points WHERE raider_id = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT 1',
  );
  const getPreCutoffGP = db.prepare(
    'SELECT points FROM epgp_gear_points WHERE raider_id = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT 1',
  );

  // Should we apply decay?
  const applyDecay =
    cutoffDate.getUTCDay() === 3 && lastUploadDate !== null && lastUploadDate > cutoffDate;

  const result: EpgpRaiderPoints[] = [];

  for (const raider of raiders) {
    const latestEP = (getLatestEP.get(raider.id) as { points: number } | undefined)?.points ?? 0;
    const latestGP = (getLatestGP.get(raider.id) as { points: number } | undefined)?.points ?? 0;

    const preCutoffEP =
      (getPreCutoffEP.get(raider.id, cutoffIso) as { points: number } | undefined)?.points ?? 0;
    const preCutoffGP =
      (getPreCutoffGP.get(raider.id, cutoffIso) as { points: number } | undefined)?.points ?? 0;

    let decayedEP: number;
    let decayedGP: number;

    if (applyDecay) {
      decayedEP = preCutoffEP - preCutoffEP * decayMultiplier;
      decayedGP = preCutoffGP - preCutoffGP * decayMultiplier;
    } else {
      decayedEP = preCutoffEP;
      decayedGP = preCutoffGP;
    }

    const epDiff = Math.ceil(latestEP - decayedEP);
    const gpDiff = Math.ceil(latestGP - decayedGP);
    const priority = latestGP > 0 ? latestEP / latestGP : 0;

    result.push({
      characterName: raider.character_name,
      ep: latestEP,
      gp: latestGP,
      priority,
      epDiff,
      gpDiff,
    });
  }

  // Sort by priority descending
  result.sort((a, b) => b.priority - a.priority);

  return {
    lastUploadedDate,
    cutoffDate: cutoffIso,
    raiders: result,
  };
}

// Re-export mappings for tests
export { TIER_TOKEN_CLASSES, ARMOUR_TYPE_CLASSES };

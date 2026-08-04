export interface WclEncounter {
  id: number;
  name: string;
}

export interface WclZone {
  id: number;
  name: string;
  expansion: string;
  encounters: WclEncounter[];
}

export interface WclExpansion {
  id: number;
  name: string;
  zones: {
    id: number;
    name: string;
    difficulties: { id: number; name: string }[];
    encounters: WclEncounter[];
  }[];
}

export const MYTHIC_DIFFICULTY = 5;
const DEFAULT_EXPANSIONS_BACK = 3;
/** Zone ids at or above this are "Complete Raids (…)" rollups, not real zones. */
const ROLLUP_ZONE_ID_FLOOR = 500;
const NON_LIVE_ZONE = /\bPTR\b|\bBeta\b|Dummy Dome/i;

/**
 * Mythic raid zones from the newest `expansionsBack` expansions. A zone's
 * `encounters` array is in boss order, so its index is the boss's depth — that
 * ordering is the whole basis of "later boss wins".
 */
export function selectMythicRaidZones(
  expansions: WclExpansion[],
  expansionsBack = DEFAULT_EXPANSIONS_BACK,
): WclZone[] {
  const newest = [...expansions].sort((a, b) => b.id - a.id).slice(0, expansionsBack);
  const out: WclZone[] = [];
  for (const expansion of newest) {
    for (const zone of expansion.zones) {
      if (!zone.difficulties.some((d) => d.id === MYTHIC_DIFFICULTY)) continue;
      if (zone.id >= ROLLUP_ZONE_ID_FLOOR) continue;
      if (NON_LIVE_ZONE.test(zone.name)) continue;
      if (zone.encounters.length < 2) continue;
      out.push({
        id: zone.id,
        name: zone.name,
        expansion: expansion.name,
        encounters: [...zone.encounters],
      });
    }
  }
  return out;
}

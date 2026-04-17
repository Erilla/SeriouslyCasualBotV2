/**
 * Parse EPGP addon JSON upload format into structured data.
 */

export interface EpgpRosterEntry {
  characterName: string;
  realm: string;
  ep: number;
  gp: number;
}

export interface EpgpLootEntry {
  timestamp: number;
  characterName: string;
  realm: string;
  itemString: string;
  gp: number;
}

export interface EpgpUploadData {
  guild: string;
  region: string;
  realm: string;
  decayPercent: number;
  roster: EpgpRosterEntry[];
  loot: EpgpLootEntry[];
}

interface RawUpload {
  Guild: string;
  Region: string;
  Realm: string;
  Min_ep: number;
  Base_gp: number;
  Decay_p: number;
  Extras_p: number;
  Timestamp: number;
  Roster: [string, number, number][];
  Loot: [number, string, string, number][];
}

function splitNameRealm(nameRealm: string): { characterName: string; realm: string } {
  const dashIndex = nameRealm.indexOf('-');
  if (dashIndex === -1) {
    return { characterName: nameRealm, realm: '' };
  }
  return {
    characterName: nameRealm.slice(0, dashIndex),
    realm: nameRealm.slice(dashIndex + 1),
  };
}

export function parseEpgpUpload(jsonString: string): EpgpUploadData {
  const raw = JSON.parse(jsonString) as RawUpload;

  const roster: EpgpRosterEntry[] = (raw.Roster ?? []).map((entry) => {
    const { characterName, realm } = splitNameRealm(entry[0]);
    return {
      characterName,
      realm,
      ep: entry[1],
      gp: entry[2],
    };
  });

  const loot: EpgpLootEntry[] = (raw.Loot ?? []).map((entry) => {
    const { characterName, realm } = splitNameRealm(entry[1]);
    return {
      timestamp: entry[0],
      characterName,
      realm,
      itemString: entry[2],
      gp: entry[3],
    };
  });

  return {
    guild: raw.Guild,
    region: raw.Region,
    realm: raw.Realm,
    decayPercent: raw.Decay_p,
    roster,
    loot,
  };
}

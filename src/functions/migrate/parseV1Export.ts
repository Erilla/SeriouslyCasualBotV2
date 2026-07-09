import type Database from 'better-sqlite3';

export const CURRENT_TIER_BOSS_IDS: readonly number[] = [
  197132, 197133, 197134, 197135, 197136, 197137, 197138, 197139, 197140,
];

export interface V1IdentityEntry {
  characterName: string;
  discordUserId: string;
}
export interface V1Overlord {
  name: string;
  userId: string;
}
export interface V1Votes {
  major: string[];
  minor: string[];
  wantIn: string[];
  wantOut: string[];
}
export interface V1LootPost {
  bossId: number;
  bossName: string;
  bossUrl: string | null;
  votes: V1Votes;
}
export interface V1Export {
  identityMap: V1IdentityEntry[];
  overlords: V1Overlord[];
  ignored: string[];
  lootPosts: V1LootPost[];
}

interface KeyvEnvelope {
  value?: unknown;
}

function unwrap(raw: string): unknown {
  try {
    const parsed = JSON.parse(raw) as KeyvEnvelope;
    return parsed.value;
  } catch {
    return undefined;
  }
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
}

export function parseV1Export(v1Db: Database.Database): V1Export {
  const rows = v1Db.prepare('SELECT key, value FROM keyv').all() as {
    key: string;
    value: string;
  }[];

  const out: V1Export = { identityMap: [], overlords: [], ignored: [], lootPosts: [] };
  const tier = new Set(CURRENT_TIER_BOSS_IDS);

  for (const { key, value } of rows) {
    const sep = key.indexOf(':');
    if (sep < 0) continue;
    const ns = key.slice(0, sep);
    const rest = key.slice(sep + 1);

    if (ns === 'raiders') {
      const id = unwrap(value);
      if (typeof id === 'string' && id) {
        out.identityMap.push({ characterName: rest, discordUserId: id });
      }
    } else if (ns === 'overlords') {
      const id = unwrap(value);
      if (typeof id === 'string' && id) {
        out.overlords.push({ name: rest, userId: id });
      }
    } else if (ns === 'ignoredCharacters') {
      out.ignored.push(rest);
    } else if (ns === 'lootResponses') {
      const bossId = Number(rest);
      if (!rest || !Number.isInteger(bossId) || !tier.has(bossId)) continue;
      const payload = unwrap(value) as Record<string, unknown> | undefined;
      if (!payload) continue;
      out.lootPosts.push({
        bossId,
        bossName: String(payload.bossName ?? ''),
        bossUrl: payload.bossUrl != null ? String(payload.bossUrl) : null,
        votes: {
          major: asStringArray(payload.major),
          minor: asStringArray(payload.minor),
          wantIn: asStringArray(payload.wantIn),
          wantOut: asStringArray(payload.wantOut),
        },
      });
    }
  }

  return out;
}

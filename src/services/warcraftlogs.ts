import { config } from '../config.js';
import { logger } from './logger.js';
import { httpRequest, HttpError, CircuitOpenError } from './httpClient.js';
import { normalizeName } from '../functions/raids/normalizeName.js';
import {
  selectMythicRaidZones,
  type WclExpansion,
  type WclZone,
} from '../functions/applications/mythic-logs/zoneCatalogue.js';
import { shouldPreemptWclPoints } from '../functions/applications/intel/rateLimit.js';
import type { RaiderIoCharacter } from '../functions/applications/characterLinks.js';

// ─── Token Cache ─────────────────────────────────────────────

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

interface TokenResponse {
  access_token: string;
  expires_in: number;
}

async function getAccessToken(): Promise<string> {
  const now = Date.now();

  if (cachedToken && now < tokenExpiresAt) {
    return cachedToken;
  }

  const body = new URLSearchParams({ grant_type: 'client_credentials' });

  const data = await httpRequest<TokenResponse>(
    'warcraftlogs',
    'https://www.warcraftlogs.com/oauth/token',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization:
          'Basic ' +
          Buffer.from(`${config.warcraftLogsClientId}:${config.warcraftLogsClientSecret}`).toString(
            'base64',
          ),
      },
      body: body.toString(),
    },
  );

  cachedToken = data.access_token;
  // Expire 60 seconds early to avoid edge cases
  tokenExpiresAt = now + (data.expires_in - 60) * 1000;

  logger.debug('WarcraftLogs', 'Refreshed OAuth2 access token');

  return cachedToken;
}

/** Testing seam — clears the process-lifetime OAuth token cache. */
export function resetAccessTokenCache(): void {
  cachedToken = null;
  tokenExpiresAt = 0;
}

// ─── GraphQL Query ───────────────────────────────────────────

interface AttendancePlayer {
  name: string;
  presence: number;
  type: string;
}

export interface AttendanceReport {
  code: string;
  players: AttendancePlayer[];
}

interface GuildAttendanceResponse {
  data: {
    guildData: {
      guild: {
        id: number;
        name: string;
        attendance: {
          data: AttendanceReport[];
        };
      };
    };
  };
}

const ATTENDANCE_QUERY = `
  query getGuildAttendance($guildId: Int) {
    guildData {
      guild(id: $guildId) {
        id
        name
        attendance {
          data {
            code
            players { name, presence, type }
          }
        }
      }
    }
  }
`;

/**
 * From WCL attendance reports, return the codes of reports where a player
 * matching `characterName` (case- and accent-insensitive, via the shared
 * normalizeName) was present (`presence === 1`).
 *
 * The result is reversed relative to input to preserve V1 ordering: consumers
 * number the output "1. Report ...", WCL's natural attendance order isn't
 * contractually documented, and .reverse() has been in place since V1 —
 * flipping it would silently change what reviewers see.
 */
export function extractMatchingCodes(reports: AttendanceReport[], characterName: string): string[] {
  const target = normalizeName(characterName);
  return reports
    .filter((report) =>
      report.players.some(
        (player) => player.presence === 1 && normalizeName(player.name) === target,
      ),
    )
    .map((report) => report.code)
    .reverse();
}

/**
 * Fetch WarcraftLogs report codes where `characterName` was present.
 * Returns empty array on any HTTP error or open circuit (fail-soft).
 */
export async function getTrialLogs(characterName: string): Promise<string[]> {
  try {
    const token = await getAccessToken();

    const result = await httpRequest<GuildAttendanceResponse>(
      'warcraftlogs',
      'https://www.warcraftlogs.com/api/v2/client',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: ATTENDANCE_QUERY,
          variables: {
            guildId: parseInt(config.warcraftLogsGuildId, 10),
          },
        }),
      },
    );

    const reports = result.data.guildData.guild.attendance.data;

    // Case- and accent-insensitive match on both sides; ordering rationale
    // lives on extractMatchingCodes.
    return extractMatchingCodes(reports, characterName);
  } catch (error) {
    if (error instanceof HttpError || error instanceof CircuitOpenError) {
      logger.warn(
        'WarcraftLogs',
        `Failed to fetch trial logs for "${characterName}": ${error.message}`,
      );
      return [];
    }
    throw error;
  }
}

// ─── Zone Catalogue ──────────────────────────────────────────

const ZONE_CATALOGUE_QUERY = `
  query zoneCatalogue {
    worldData {
      expansions {
        id
        name
        zones {
          id
          name
          difficulties { id name }
          encounters { id name }
        }
      }
    }
  }
`;

let cachedZones: WclZone[] | null = null;

/**
 * Mythic raid zones for the last three expansions, cached for the process
 * lifetime — the catalogue changes only on patch day and the query costs ~19
 * rate-limit points.
 */
export async function getZoneCatalogue(): Promise<WclZone[]> {
  if (cachedZones) return cachedZones;
  const token = await getAccessToken();
  const result = await httpRequest<{ data: { worldData: { expansions: WclExpansion[] } } }>(
    'warcraftlogs',
    'https://www.warcraftlogs.com/api/v2/client',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: ZONE_CATALOGUE_QUERY }),
    },
  );
  cachedZones = selectMythicRaidZones(result.data.worldData.expansions);
  logger.debug('WarcraftLogs', `Zone catalogue: ${cachedZones.length} Mythic raid zones`);
  return cachedZones;
}

/** Testing seam — clears the process cache. */
export function resetZoneCatalogueCache(): void {
  cachedZones = null;
}

// ─── Per-character kill, report and wipe queries ────────────

/** Thrown before WCL refuses us, so the job pauses on our terms. */
export class WclPointsExhausted extends Error {
  readonly service = 'warcraftlogs' as const;
  constructor(spent: number, limit: number) {
    super(`WarcraftLogs points nearly exhausted: ${spent}/${limit} this hour`);
    this.name = 'WclPointsExhausted';
  }
}

interface RateLimitEnvelope {
  rateLimitData?: { limitPerHour: number; pointsSpentThisHour: number };
}

async function query<T extends RateLimitEnvelope>(
  gql: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const token = await getAccessToken();
  const result = await httpRequest<{ data: T }>(
    'warcraftlogs',
    'https://www.warcraftlogs.com/api/v2/client',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: gql, variables }),
    },
  );
  const rl = result.data.rateLimitData;
  if (rl && shouldPreemptWclPoints(rl.pointsSpentThisHour, rl.limitPerHour)) {
    throw new WclPointsExhausted(rl.pointsSpentThisHour, rl.limitPerHour);
  }
  return result.data;
}

interface WclCharacterById {
  name?: string | null;
  hidden?: boolean | null;
  canonicalID?: number | null;
  server?: {
    slug?: string | null;
    region?: { slug?: string | null } | null;
  } | null;
}

interface WclCharacterBatch extends RateLimitEnvelope {
  characterData: Record<string, WclCharacterById | null>;
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

async function resolveWclCharacterBatch(
  ids: number[],
): Promise<Map<number, WclCharacterById | null>> {
  if (ids.length === 0) return new Map();

  const variables = Object.fromEntries(ids.map((id, index) => [`id${index}`, id]));
  const definitions = ids.map((_, index) => `$id${index}: Int!`).join(', ');
  const fields = ids
    .map(
      (_, index) => `
        c${index}: character(id: $id${index}) {
          name
          hidden
          canonicalID
          server { slug region { slug } }
        }`,
    )
    .join('');
  const gql = `
    query resolveWclCharacters(${definitions}) {
      characterData {${fields}
      }
      rateLimitData { limitPerHour pointsSpentThisHour }
    }
  `;
  const data = await query<WclCharacterBatch>(gql, variables);
  return new Map(ids.map((id, index) => [id, data.characterData[`c${index}`] ?? null]));
}

function wclCharacterIdentity(character: WclCharacterById | null): RaiderIoCharacter | null {
  const name = character?.name?.trim();
  const realm = character?.server?.slug?.trim();
  const region = character?.server?.region?.slug?.trim();
  if (!name || !realm || !region) return null;
  return {
    region: region.toLocaleLowerCase(),
    realm: realm.toLocaleLowerCase(),
    name,
  };
}

/** Resolve numeric WCL profile IDs, following each canonical redirect at most once. */
export async function resolveWclCharacterIds(
  ids: number[],
): Promise<Map<number, RaiderIoCharacter | null>> {
  const resolved = new Map<number, RaiderIoCharacter | null>();
  for (const id of ids) resolved.set(id, null);

  const positiveIds = [...new Set(ids.filter(isPositiveInteger))];
  if (positiveIds.length === 0) return resolved;

  const initial = await resolveWclCharacterBatch(positiveIds);
  // An unrenamed character reports its OWN id as canonicalID, so following every
  // canonicalID blindly would re-request the whole batch verbatim and double the
  // point spend. Only ids the first batch did not already answer are worth a
  // second round trip.
  const canonicalIds = [
    ...new Set(
      positiveIds
        .map((id) => initial.get(id)?.canonicalID)
        .filter((id): id is number => id != null && isPositiveInteger(id))
        .filter((id) => !initial.has(id)),
    ),
  ];
  const canonical =
    canonicalIds.length > 0 ? await resolveWclCharacterBatch(canonicalIds) : new Map();

  for (const id of positiveIds) {
    const direct = initial.get(id) ?? null;
    const canonicalId = direct?.canonicalID;
    const character =
      canonicalId != null && isPositiveInteger(canonicalId)
        ? (initial.get(canonicalId) ?? canonical.get(canonicalId) ?? null)
        : direct;
    resolved.set(id, wclCharacterIdentity(character));
  }

  return resolved;
}

export interface ZoneKill {
  encounterId: number;
  totalKills: number;
}

const ZONE_KILLS_QUERY = `
  query zoneKills($name: String!, $realm: String!, $region: String!, $zone: Int!) {
    characterData {
      character(name: $name, serverSlug: $realm, serverRegion: $region) {
        zoneRankings(zoneID: $zone, difficulty: 5, metric: dps)
      }
    }
    rateLimitData { limitPerHour pointsSpentThisHour }
  }
`;

/**
 * Which bosses this character killed in a zone, keyed on WCL encounter ids.
 * The structural source of truth: it decides "killed or not", so no
 * cross-source name matching can ever drop a boss.
 */
export async function getZoneKills(c: RaiderIoCharacter, zoneId: number): Promise<ZoneKill[]> {
  const data = await query<
    RateLimitEnvelope & {
      characterData: {
        character: {
          zoneRankings?: { rankings?: { encounter?: { id: number }; totalKills?: number }[] };
        } | null;
      };
    }
  >(ZONE_KILLS_QUERY, {
    name: c.name,
    realm: c.realm,
    region: c.region.toUpperCase(),
    zone: zoneId,
  });

  return (data.characterData.character?.zoneRankings?.rankings ?? [])
    .filter((r) => (r.totalKills ?? 0) > 0 && r.encounter?.id)
    .map((r) => ({ encounterId: r.encounter!.id, totalKills: r.totalKills! }));
}

export interface EncounterKill {
  reportCode: string;
  startTime: number;
}

const ENCOUNTER_KILLS_QUERY = `
  query encounterKills($name: String!, $realm: String!, $region: String!, $encounter: Int!) {
    characterData {
      character(name: $name, serverSlug: $realm, serverRegion: $region) {
        encounterRankings(encounterID: $encounter, difficulty: 5, metric: dps)
      }
    }
    rateLimitData { limitPerHour pointsSpentThisHour }
  }
`;

/** This character's own kills of one boss, oldest first — index 0 is their
 *  first kill, and each entry carries the report to link. */
export async function getEncounterKills(
  c: RaiderIoCharacter,
  encounterId: number,
): Promise<EncounterKill[]> {
  const data = await query<
    RateLimitEnvelope & {
      characterData: {
        character: {
          encounterRankings?: { ranks?: { startTime: number; report?: { code: string } }[] };
        } | null;
      };
    }
  >(ENCOUNTER_KILLS_QUERY, {
    name: c.name,
    realm: c.realm,
    region: c.region.toUpperCase(),
    encounter: encounterId,
  });

  return (data.characterData.character?.encounterRankings?.ranks ?? [])
    .filter((r) => r.report?.code)
    .map((r) => ({ reportCode: r.report!.code, startTime: r.startTime }))
    .sort((a, b) => a.startTime - b.startTime);
}

export interface RaidReportRef {
  code: string;
  startTime: number;
  zoneId: number;
}

const RECENT_REPORTS_QUERY = `
  query recentReports($name: String!, $realm: String!, $region: String!, $page: Int!) {
    characterData {
      character(name: $name, serverSlug: $realm, serverRegion: $region) {
        recentReports(limit: 100, page: $page) {
          has_more_pages
          data { code startTime zone { id } }
        }
      }
    }
    rateLimitData { limitPerHour pointsSpentThisHour }
  }
`;

/** Reports this character appears in that belong to one of `zoneIds`. Presence
 *  in a report proves nothing about a given pull — see getReportWipes. */
export async function getRaidReports(
  c: RaiderIoCharacter,
  zoneIds: Set<number>,
  maxPages = 6,
): Promise<RaidReportRef[]> {
  const out: RaidReportRef[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const data = await query<
      RateLimitEnvelope & {
        characterData: {
          character: {
            recentReports?: {
              has_more_pages: boolean;
              data: { code: string; startTime: number; zone?: { id: number } }[];
            };
          } | null;
        };
      }
    >(RECENT_REPORTS_QUERY, {
      name: c.name,
      realm: c.realm,
      region: c.region.toUpperCase(),
      page,
    });

    const reports = data.characterData.character?.recentReports;
    if (!reports) break;
    for (const r of reports.data) {
      if (r.zone?.id && zoneIds.has(r.zone.id)) {
        out.push({ code: r.code, startTime: r.startTime, zoneId: r.zone.id });
      }
    }
    if (!reports.has_more_pages) break;
  }
  return out;
}

export interface WipePull {
  encounterId: number;
  fightId: number;
  fightPercentage: number;
  players: string[];
}

const REPORT_WIPES_QUERY = `
  query reportWipes($code: String!) {
    reportData {
      report(code: $code) {
        masterData { actors(type: "Player") { id name } }
        fights(killType: All, difficulty: 5) {
          id
          encounterID
          kill
          fightPercentage
          friendlyPlayers
        }
      }
    }
    rateLimitData { limitPerHour pointsSpentThisHour }
  }
`;

/**
 * Every wipe pull in a report with the names of who was actually in it.
 * `friendlyPlayers` + `masterData.actors` gives per-pull rosters in ONE query;
 * `playerDetails` answers the same question one pull at a time, and a single
 * boss can have 40+ pulls in a night.
 */
export async function getReportWipes(code: string): Promise<WipePull[]> {
  const data = await query<
    RateLimitEnvelope & {
      reportData: {
        report: {
          masterData?: { actors?: { id: number; name: string }[] };
          fights?: {
            id: number;
            encounterID: number;
            kill: boolean;
            fightPercentage?: number;
            friendlyPlayers?: number[];
          }[];
        } | null;
      };
    }
  >(REPORT_WIPES_QUERY, { code });

  const report = data.reportData.report;
  if (!report) return [];
  const byId = new Map((report.masterData?.actors ?? []).map((a) => [a.id, a.name]));

  return (report.fights ?? [])
    .filter((f) => !f.kill)
    .map((f) => ({
      encounterId: f.encounterID,
      fightId: f.id,
      fightPercentage: f.fightPercentage ?? 100,
      players: (f.friendlyPlayers ?? [])
        .map((id) => byId.get(id))
        .filter((n): n is string => Boolean(n)),
    }));
}

import { config } from '../config.js';
import { logger } from './logger.js';
import { httpRequest, HttpError, CircuitOpenError } from './httpClient.js';
import { normalizeName } from '../functions/raids/normalizeName.js';
import {
  selectMythicRaidZones,
  type WclExpansion,
  type WclZone,
} from '../functions/applications/mythic-logs/zoneCatalogue.js';

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

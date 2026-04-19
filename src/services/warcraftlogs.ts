import { config } from '../config.js';
import { logger } from './logger.js';
import { httpRequest, HttpError, CircuitOpenError } from './httpClient.js';

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
          Buffer.from(
            `${config.warcraftLogsClientId}:${config.warcraftLogsClientSecret}`,
          ).toString('base64'),
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

interface AttendanceReport {
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
 * Fetch WarcraftLogs report codes where `characterName` was present.
 * Returns codes in reverse chronological order (newest first).
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

    const matchingCodes = reports
      .filter((report) =>
        report.players.some(
          (player) =>
            player.name === characterName && player.presence === 1,
        ),
      )
      .map((report) => report.code);

    // WCL's attendance.data is already newest-first; don't reverse.
    return matchingCodes;
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

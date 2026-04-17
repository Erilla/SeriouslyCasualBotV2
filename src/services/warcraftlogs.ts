import { config } from '../config.js';
import { logger } from './logger.js';

// ─── Token Cache ─────────────────────────────────────────────

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

async function getAccessToken(): Promise<string> {
  const now = Date.now();

  if (cachedToken && now < tokenExpiresAt) {
    return cachedToken;
  }

  const body = new URLSearchParams({ grant_type: 'client_credentials' });

  const response = await fetch('https://www.warcraftlogs.com/oauth/token', {
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
  });

  if (!response.ok) {
    throw new Error(
      `WarcraftLogs OAuth error: ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as {
    access_token: string;
    expires_in: number;
  };

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
 * Returns empty array on error.
 */
export async function getTrialLogs(characterName: string): Promise<string[]> {
  try {
    const token = await getAccessToken();

    const response = await fetch(
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

    if (!response.ok) {
      logger.warn(
        'WarcraftLogs',
        `API error: ${response.status} ${response.statusText}`,
      );
      return [];
    }

    const result = (await response.json()) as GuildAttendanceResponse;
    const reports = result.data.guildData.guild.attendance.data;

    // Filter reports where the character was present (presence === 1)
    const matchingCodes = reports
      .filter((report) =>
        report.players.some(
          (player) =>
            player.name === characterName && player.presence === 1,
        ),
      )
      .map((report) => report.code);

    // Reverse chronological order (API returns newest first, but reverse to be safe)
    return matchingCodes.reverse();
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.warn(
      'WarcraftLogs',
      `Failed to fetch trial logs for "${characterName}": ${err.message}`,
    );
    return [];
  }
}

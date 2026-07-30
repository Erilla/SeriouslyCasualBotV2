import { config } from '../config.js';
import { httpRequest } from './httpClient.js';

export interface BlizzardSocket {
  socket_type?: string;
  item?: {
    name?: string;
  };
}

export interface BlizzardEquippedItem {
  slot: {
    type: string;
  };
  item: {
    name: string;
  };
  enchantments?: unknown[];
  sockets?: BlizzardSocket[];
}

export interface BlizzardEquipmentProfile {
  equipped_items: BlizzardEquippedItem[];
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
}

let cachedToken: string | null = null;
let tokenExpiresAt = 0;
let inFlightToken: Promise<string> | null = null;

function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt) {
    return Promise.resolve(cachedToken);
  }

  if (inFlightToken) return inFlightToken;

  const body = new URLSearchParams({ grant_type: 'client_credentials' });
  const request = httpRequest<TokenResponse>('blizzard', 'https://oauth.battle.net/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization:
        'Basic ' +
        Buffer.from(`${config.blizzardClientId}:${config.blizzardClientSecret}`).toString('base64'),
    },
    body: body.toString(),
  }).then((data) => {
    cachedToken = data.access_token;
    tokenExpiresAt = now + Math.max(0, data.expires_in - 60) * 1000;
    return cachedToken;
  });

  const inFlightRequest = request.finally(() => {
    if (inFlightToken === inFlightRequest) inFlightToken = null;
  });
  inFlightToken = inFlightRequest;
  return inFlightRequest;
}

export async function getCharacterEquipment(
  region: string,
  realm: string,
  name: string,
): Promise<BlizzardEquipmentProfile> {
  const token = await getAccessToken();
  const url =
    `https://${region}.api.blizzard.com/profile/wow/character/` +
    `${encodeURIComponent(realm.toLowerCase())}/${encodeURIComponent(name.toLowerCase())}/equipment` +
    `?namespace=profile-${region}&locale=en_GB`;

  return httpRequest<BlizzardEquipmentProfile>('blizzard', url, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

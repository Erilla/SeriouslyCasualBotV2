import { config } from '../config.js';
import { httpRequest } from './httpClient.js';

const BASE_URL = 'https://wowaudit.com/v1';

function headers(): Record<string, string> {
  return {
    accept: 'application/json',
    Authorization: config.wowAuditApiSecret,
  };
}

export interface WowAuditRaid {
  id: number;
  date: string;
  title: string;
  note: string;
  signups: Array<{
    character: {
      name: string;
      realm: string;
      class_name: string;
    };
    status: string;
  }>;
}

export interface WowAuditHistoricalEntry {
  character: {
    name: string;
    realm: string;
  };
  data: Record<string, unknown>;
}

async function getCurrentPeriod(): Promise<number> {
  const data = await httpRequest<{ current_period: number }>(
    'wowaudit',
    `${BASE_URL}/period`,
    { headers: headers() },
  );
  return data.current_period;
}

export async function getUpcomingRaids(): Promise<WowAuditRaid[]> {
  return httpRequest<WowAuditRaid[]>(
    'wowaudit',
    `${BASE_URL}/raids?include_past=false`,
    { headers: headers() },
  );
}

export async function getHistoricalData(): Promise<WowAuditHistoricalEntry[]> {
  const currentPeriod = await getCurrentPeriod();
  const previousPeriod = currentPeriod - 1;

  return httpRequest<WowAuditHistoricalEntry[]>(
    'wowaudit',
    `${BASE_URL}/historical_data?period=${previousPeriod}`,
    { headers: headers() },
  );
}

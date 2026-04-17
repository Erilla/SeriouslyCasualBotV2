import { config } from '../config.js';

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
  const response = await fetch(`${BASE_URL}/period`, { headers: headers() });
  if (!response.ok) {
    throw new Error(`WoW Audit API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { current_period: number };
  return data.current_period;
}

export async function getUpcomingRaids(): Promise<WowAuditRaid[]> {
  const response = await fetch(`${BASE_URL}/raids?include_past=false`, { headers: headers() });
  if (!response.ok) {
    throw new Error(`WoW Audit API error: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as WowAuditRaid[];
}

export async function getHistoricalData(): Promise<WowAuditHistoricalEntry[]> {
  const currentPeriod = await getCurrentPeriod();
  const previousPeriod = currentPeriod - 1;

  const response = await fetch(`${BASE_URL}/historical_data?period=${previousPeriod}`, {
    headers: headers(),
  });
  if (!response.ok) {
    throw new Error(`WoW Audit API error: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as WowAuditHistoricalEntry[];
}

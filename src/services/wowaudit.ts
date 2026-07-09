import { config } from '../config.js';
import { httpRequest } from './httpClient.js';

const BASE_URL = 'https://wowaudit.com/v1';

function headers(): Record<string, string> {
  return {
    accept: 'application/json',
    Authorization: config.wowAuditApiSecret,
  };
}

// The /raids list endpoint returns these fields (no signups — see WowAuditRaidDetail).
export interface WowAuditRaid {
  id: number;
  date: string;
  start_time: string;
  end_time: string;
  instance: string;
  difficulty: string; // e.g. "Mythic"
  status: string; // e.g. "Planned", "Cancelled"
  present_size: number;
  total_size: number;
}

export interface WowAuditSignup {
  character: {
    name: string;
    realm: string;
    class: string;
    role: string;
  };
  status: string; // "Present" | "Absent" | "Late" | "Tentative" | "Unknown"
  comment: string | null;
  selected: boolean;
}

// The per-raid endpoint (/raids/{id}) returns the list fields plus signups.
export interface WowAuditRaidDetail extends WowAuditRaid {
  notes: string;
  signups: WowAuditSignup[];
}

// The /historical_data endpoint returns entries with name/realm at the top level
// (not nested under a `character` object) and a free-form `data` blob.
export interface WowAuditHistoricalEntry {
  id: number;
  name: string;
  realm: string;
  data: Record<string, unknown>;
}

async function getCurrentPeriod(): Promise<number> {
  const data = await httpRequest<{ current_period: number }>('wowaudit', `${BASE_URL}/period`, {
    headers: headers(),
  });
  return data.current_period;
}

export async function getUpcomingRaids(): Promise<WowAuditRaid[]> {
  // The /raids endpoint wraps the list in an object: { raids: [...] }.
  const data = await httpRequest<{ raids: WowAuditRaid[] }>(
    'wowaudit',
    `${BASE_URL}/raids?include_past=false`,
    { headers: headers() },
  );
  return data.raids;
}

// Signups are only returned by the per-raid endpoint, not the list above.
export async function getRaid(id: number): Promise<WowAuditRaidDetail> {
  return httpRequest<WowAuditRaidDetail>('wowaudit', `${BASE_URL}/raids/${id}`, {
    headers: headers(),
  });
}

export async function getHistoricalData(): Promise<WowAuditHistoricalEntry[]> {
  const currentPeriod = await getCurrentPeriod();
  const previousPeriod = currentPeriod - 1;

  // The /historical_data endpoint wraps the list in an object: { period, characters: [...] }.
  const data = await httpRequest<{ period: number; characters: WowAuditHistoricalEntry[] }>(
    'wowaudit',
    `${BASE_URL}/historical_data?period=${previousPeriod}`,
    { headers: headers() },
  );
  return data.characters;
}

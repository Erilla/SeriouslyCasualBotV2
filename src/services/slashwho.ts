import { httpRequest } from './httpClient.js';

/**
 * Client for SlashWho's bot-facing dossier API (`/api/v1`, Erilla/SlashWho#916,
 * shipped in Erilla/SlashWho#917). The contract lives in that repo at
 * `packages/contracts/src/bot-dossier.ts`; the types below mirror the fields the
 * bot reads and nothing more.
 *
 * Responses are checked at the boundary by small guards rather than trusted:
 * the repo has no schema library, and a SlashWho release that renamed a field
 * should fail loudly here as a SlashWhoContractError, not as an `undefined`
 * deep inside the renderer. Unknown fields are ignored, so SlashWho can add
 * fields without breaking the bot.
 */

export interface DossierKey {
  region: string;
  realm: string;
  name: string;
}

/** How the bot should read a dossier: wait, publish, or publish with a note. */
export type DossierState = 'collecting' | 'ready' | 'partial';

export type DossierSource =
  | 'submitted'
  | 'raiderio_declared'
  | 'fingerprint_derived'
  | 'manually_added';

export interface DossierGuild {
  name: string;
  region: string;
  realm: string;
}

export interface DossierCharacter {
  key: DossierKey;
  displayName: string;
  className: string | null;
  guild: DossierGuild | null;
  source: DossierSource;
  /** Always null in v1: SlashWho keeps no fingerprint score. Never infer one. */
  confidence: number | null;
  evidenceState: string;
  pending: boolean;
}

export interface DossierGuildRaid {
  raidName: string;
  kills: number;
  firstKillAt: string;
  lastKillAt: string;
  /** `region/realm/name` identities. */
  characters: string[];
}

export interface DossierGuildHistory {
  guild: DossierGuild;
  firstNight: string;
  lastNight: string;
  raidNights: number;
  tiers: string[];
  characters: string[];
  raids: DossierGuildRaid[];
}

export interface DossierBoss {
  bossName: string;
  state: 'kill' | 'wipe';
  firstKilledAt: string | null;
  characters: string[];
  worldRank: number | null;
  reportUrl: string | null;
}

export interface DossierRaid {
  raidName: string;
  bosses: DossierBoss[];
}

export interface DossierCuttingEdge {
  achievementName: string;
  completedAt: string;
}

export interface DossierLimitation {
  code: string;
  affects: string;
  character: DossierKey | null;
}

export interface DossierSummary {
  root: DossierKey;
  state: DossierState;
  snapshotId: string | null;
  lastCollectedAt: string | null;
  /** False means `cuttingEdges` is incomplete, not that none exist. */
  cuttingEdgesRestored: boolean;
  characters: DossierCharacter[];
  guildHistory: DossierGuildHistory[];
  raids: DossierRaid[];
  raidsTruncated: boolean;
  cuttingEdges: DossierCuttingEdge[];
  limitations: DossierLimitation[];
}

export interface DossierStatus {
  state: DossierState;
  snapshotId: string | null;
  lastCollectedAt: string | null;
  evidenceRunIds: string[];
}

export type CreateOutcome =
  | 'queued'
  | 'existing'
  | 'rate_limited'
  | 'suppressed'
  | 'not_found'
  | 'failed';

export interface CreateDossierResult extends DossierStatus {
  root: DossierKey;
  outcomes: { key: DossierKey; outcome: CreateOutcome; jobId?: string }[];
  retryAfterSeconds?: number;
}

export interface AddCharacterResult {
  kind: 'linked';
  jobId?: string;
}

export interface RefreshResult {
  mode: string;
  lastCollectedAt: string | null;
}

/**
 * The surface the intel runner depends on. Injected, so tests drive the runner
 * with a fake and never touch the network.
 */
export interface SlashWhoClient {
  /** `POST /api/v1/dossiers` — one create carrying every declared character. */
  ensureDossier(characterUrls: string[]): Promise<CreateDossierResult>;
  /** `GET .../status` — the cheap poll. */
  getStatus(root: DossierKey): Promise<DossierStatus>;
  /** `GET /api/v1/dossiers/{region}/{realm}/{name}` — the chat-sized summary. */
  getDossier(root: DossierKey): Promise<DossierSummary>;
  /** `POST .../characters` — link one more character to the dossier. */
  addDossierCharacter(root: DossierKey, characterUrl: string): Promise<AddCharacterResult>;
  /** `POST .../refresh` — the only summary-side call that may spend provider budget. */
  refreshDossier(root: DossierKey): Promise<RefreshResult>;
}

export class SlashWhoContractError extends Error {
  constructor(what: string, path: string) {
    super(`SlashWho ${what} response did not match the v1 contract at ${path}`);
    this.name = 'SlashWhoContractError';
  }
}

// ─── Boundary guards ─────────────────────────────────────────

type Json = Record<string, unknown>;

class Reader {
  constructor(private readonly what: string) {}

  fail(path: string): never {
    throw new SlashWhoContractError(this.what, path);
  }

  object(value: unknown, path: string): Json {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) this.fail(path);
    return value as Json;
  }

  string(value: unknown, path: string): string {
    if (typeof value !== 'string') this.fail(path);
    return value;
  }

  nullableString(value: unknown, path: string): string | null {
    return value === null ? null : this.string(value, path);
  }

  number(value: unknown, path: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) this.fail(path);
    return value;
  }

  nullableNumber(value: unknown, path: string): number | null {
    return value === null ? null : this.number(value, path);
  }

  boolean(value: unknown, path: string): boolean {
    if (typeof value !== 'boolean') this.fail(path);
    return value;
  }

  array<T>(value: unknown, path: string, each: (item: unknown, path: string) => T): T[] {
    if (!Array.isArray(value)) this.fail(path);
    return value.map((item, i) => each(item, `${path}[${i}]`));
  }

  oneOf<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
    const s = this.string(value, path);
    if (!(allowed as readonly string[]).includes(s)) this.fail(path);
    return s as T;
  }

  key(value: unknown, path: string): DossierKey {
    const o = this.object(value, path);
    return {
      region: this.string(o.region, `${path}.region`),
      realm: this.string(o.realm, `${path}.realm`),
      name: this.string(o.name, `${path}.name`),
    };
  }

  guild(value: unknown, path: string): DossierGuild {
    const o = this.object(value, path);
    return {
      name: this.string(o.name, `${path}.name`),
      region: this.string(o.region, `${path}.region`),
      realm: this.string(o.realm, `${path}.realm`),
    };
  }

  strings(value: unknown, path: string): string[] {
    return this.array(value, path, (v, p) => this.string(v, p));
  }
}

const STATES = ['collecting', 'ready', 'partial'] as const;
const SOURCES = [
  'submitted',
  'raiderio_declared',
  'fingerprint_derived',
  'manually_added',
] as const;
const OUTCOMES = [
  'queued',
  'existing',
  'rate_limited',
  'suppressed',
  'not_found',
  'failed',
] as const;

function readStatusFields(r: Reader, o: Json): DossierStatus {
  return {
    state: r.oneOf(o.state, 'state', STATES),
    snapshotId: r.nullableString(o.snapshotId, 'snapshotId'),
    lastCollectedAt: r.nullableString(o.lastCollectedAt, 'lastCollectedAt'),
    evidenceRunIds: r.strings(o.evidenceRunIds, 'evidenceRunIds'),
  };
}

export function parseStatus(body: unknown): DossierStatus {
  const r = new Reader('status');
  return readStatusFields(r, r.object(body, '$'));
}

export function parseCreateResult(body: unknown): CreateDossierResult {
  const r = new Reader('create');
  const o = r.object(body, '$');
  const outcomes = r.array(o.outcomes, 'outcomes', (v, p) => {
    const item = r.object(v, p);
    return {
      key: r.key(item.key, `${p}.key`),
      outcome: r.oneOf(item.outcome, `${p}.outcome`, OUTCOMES),
      ...(item.jobId === undefined ? {} : { jobId: r.string(item.jobId, `${p}.jobId`) }),
    };
  });
  return {
    root: r.key(o.root, 'root'),
    ...readStatusFields(r, o),
    outcomes,
    ...(o.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: r.number(o.retryAfterSeconds, 'retryAfterSeconds') }),
  };
}

export function parseSummary(body: unknown): DossierSummary {
  const r = new Reader('summary');
  const o = r.object(body, '$');
  const status = readStatusFields(r, { ...o, evidenceRunIds: [] });
  return {
    root: r.key(o.root, 'root'),
    state: status.state,
    snapshotId: status.snapshotId,
    lastCollectedAt: status.lastCollectedAt,
    cuttingEdgesRestored: r.boolean(o.cuttingEdgesRestored, 'cuttingEdgesRestored'),
    characters: r.array(o.characters, 'characters', (v, p) => {
      const c = r.object(v, p);
      return {
        key: r.key(c.key, `${p}.key`),
        displayName: r.string(c.displayName, `${p}.displayName`),
        className: r.nullableString(c.className, `${p}.className`),
        guild: c.guild === null ? null : r.guild(c.guild, `${p}.guild`),
        source: r.oneOf(c.source, `${p}.source`, SOURCES),
        confidence: r.nullableNumber(c.confidence, `${p}.confidence`),
        evidenceState: r.string(c.evidenceState, `${p}.evidenceState`),
        pending: r.boolean(c.pending, `${p}.pending`),
      };
    }),
    guildHistory: r.array(o.guildHistory, 'guildHistory', (v, p) => {
      const g = r.object(v, p);
      return {
        guild: r.guild(g.guild, `${p}.guild`),
        firstNight: r.string(g.firstNight, `${p}.firstNight`),
        lastNight: r.string(g.lastNight, `${p}.lastNight`),
        raidNights: r.number(g.raidNights, `${p}.raidNights`),
        tiers: r.strings(g.tiers, `${p}.tiers`),
        characters: r.strings(g.characters, `${p}.characters`),
        raids: r.array(g.raids, `${p}.raids`, (rv, rp) => {
          const raid = r.object(rv, rp);
          return {
            raidName: r.string(raid.raidName, `${rp}.raidName`),
            kills: r.number(raid.kills, `${rp}.kills`),
            firstKillAt: r.string(raid.firstKillAt, `${rp}.firstKillAt`),
            lastKillAt: r.string(raid.lastKillAt, `${rp}.lastKillAt`),
            characters: r.strings(raid.characters, `${rp}.characters`),
          };
        }),
      };
    }),
    raids: r.array(o.raids, 'raids', (v, p) => {
      const raid = r.object(v, p);
      return {
        raidName: r.string(raid.raidName, `${p}.raidName`),
        bosses: r.array(raid.bosses, `${p}.bosses`, (bv, bp) => {
          const b = r.object(bv, bp);
          return {
            bossName: r.string(b.bossName, `${bp}.bossName`),
            state: r.oneOf(b.state, `${bp}.state`, ['kill', 'wipe'] as const),
            firstKilledAt: r.nullableString(b.firstKilledAt, `${bp}.firstKilledAt`),
            characters: r.strings(b.characters, `${bp}.characters`),
            worldRank: r.nullableNumber(b.worldRank, `${bp}.worldRank`),
            reportUrl: r.nullableString(b.reportUrl, `${bp}.reportUrl`),
          };
        }),
      };
    }),
    raidsTruncated: r.boolean(o.raidsTruncated, 'raidsTruncated'),
    cuttingEdges: r.array(o.cuttingEdges, 'cuttingEdges', (v, p) => {
      const ce = r.object(v, p);
      return {
        achievementName: r.string(ce.achievementName, `${p}.achievementName`),
        completedAt: r.string(ce.completedAt, `${p}.completedAt`),
      };
    }),
    limitations: r.array(o.limitations, 'limitations', (v, p) => {
      const l = r.object(v, p);
      return {
        code: r.string(l.code, `${p}.code`),
        affects: r.string(l.affects, `${p}.affects`),
        character: l.character === null ? null : r.key(l.character, `${p}.character`),
      };
    }),
  };
}

export function parseAddCharacterResult(body: unknown): AddCharacterResult {
  const r = new Reader('add-character');
  const o = r.object(body, '$');
  r.oneOf(o.kind, 'kind', ['linked'] as const);
  return {
    kind: 'linked',
    ...(o.jobId === undefined ? {} : { jobId: r.string(o.jobId, 'jobId') }),
  };
}

export function parseRefreshResult(body: unknown): RefreshResult {
  const r = new Reader('refresh');
  const o = r.object(body, '$');
  return {
    mode: r.string(o.mode, 'mode'),
    lastCollectedAt: r.nullableString(o.lastCollectedAt, 'lastCollectedAt'),
  };
}

// ─── URLs ────────────────────────────────────────────────────

const segment = (value: string): string => encodeURIComponent(value.toLowerCase());

function dossierPath(root: DossierKey): string {
  return `${segment(root.region)}/${segment(root.realm)}/${segment(root.name)}`;
}

/**
 * The officer-facing dossier page. Derived from the dossier root rather than
 * stored, so it can be rebuilt from the job row at any time. (`/dossiers/…`,
 * not `/characters/…`, which 404s.)
 */
export function dossierPageUrl(baseUrl: string, root: DossierKey): string {
  return `${baseUrl}/dossiers/${dossierPath(root)}`;
}

// ─── HTTP client ─────────────────────────────────────────────

export type SlashWhoTransport = (url: string, init: RequestInit) => Promise<unknown>;

export interface SlashWhoClientOptions {
  /** No trailing slash. */
  baseUrl: string;
  apiKey: string;
  /**
   * Defaults to `httpRequest('slashwho', …)`, which feeds the `slashwho`
   * breaker and health counters and retries 429/5xx. That retry is safe for
   * every call here: SlashWho treats create and add-character idempotently.
   */
  transport?: SlashWhoTransport;
}

export function createSlashWhoClient(options: SlashWhoClientOptions): SlashWhoClient {
  const transport: SlashWhoTransport =
    options.transport ??
    ((url, init) =>
      // 401 and 400 end the job after one request (slashwhoJob's terminal
      // path), so counting them would only open the breaker and turn a bad
      // key into "rate limited" for every later job.
      httpRequest<unknown>('slashwho', url, init, { breakerNeutralStatuses: [400, 401] }));
  const headers = {
    accept: 'application/json',
    authorization: `Bearer ${options.apiKey}`,
  };
  const get = (path: string): Promise<unknown> =>
    transport(`${options.baseUrl}/api/v1/${path}`, { method: 'GET', headers });
  const post = (path: string, body?: unknown): Promise<unknown> =>
    transport(`${options.baseUrl}/api/v1/${path}`, {
      method: 'POST',
      headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  return {
    async ensureDossier(characterUrls) {
      return parseCreateResult(await post('dossiers', { characters: characterUrls }));
    },
    async getStatus(root) {
      return parseStatus(await get(`dossiers/${dossierPath(root)}/status`));
    },
    async getDossier(root) {
      return parseSummary(await get(`dossiers/${dossierPath(root)}`));
    },
    async addDossierCharacter(root, characterUrl) {
      return parseAddCharacterResult(
        await post(`dossiers/${dossierPath(root)}/characters`, { characterUrl }),
      );
    },
    async refreshDossier(root) {
      return parseRefreshResult(await post(`dossiers/${dossierPath(root)}/refresh`));
    },
  };
}

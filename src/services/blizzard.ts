import { gunzipSync, gzipSync } from 'zlib';
import { config } from '../config.js';
import { httpRequest, CircuitOpenError, HttpError } from './httpClient.js';
import { getCachedOrFetch, ttl } from './apiCache.js';
import { logger } from './logger.js';
import type { RaiderIoCharacter } from '../functions/applications/characterLinks.js';
import type { Fingerprint } from '../functions/applications/alts/compareFingerprints.js';

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

function ruleRealmFallback(realm: string): string {
  return realm.trim().toLowerCase().replace(/\s+/g, '-');
}

/**
 * Compatibility normalizer for the synchronous alt-discovery key paths. New API
 * callers must use resolveRealmSlug so display names and existing slugs are
 * disambiguated by Blizzard's realm index.
 *
 * @deprecated Pass canonical resolved realm slugs through the async lifecycle.
 */
export function normalizeRealmSlug(realm: string): string {
  return ruleRealmFallback(realm);
}

/** Blizzard's guild-name slug rule: punctuation is removed, spaces become hyphens. */
export function guildNameSlug(name: string): string {
  return name
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, '-');
}

interface RealmIndex {
  realms?: { name?: string; slug?: string }[];
}

const REALM_INDEX_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function foldRealm(value: string): string {
  return value
    .normalize('NFD')
    .toLocaleLowerCase()
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function realmIndexLocale(region: string): string {
  if (region === 'kr') return 'ko_KR';
  if (region === 'tw') return 'zh_TW';
  if (region === 'us') return 'en_US';
  return 'en_GB';
}

async function fetchRealmIndex(region: string): Promise<RealmIndex> {
  const token = await getAccessToken();
  const url =
    `https://${region}.api.blizzard.com/data/wow/realm/index` +
    `?namespace=dynamic-${region}&locale=${realmIndexLocale(region)}`;
  return httpRequest<RealmIndex>('blizzard', url, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

/** Resolve either a realm display name or an API slug to Blizzard's canonical slug. */
export async function resolveRealmSlug(region: string, realm: string): Promise<string> {
  const normalizedRegion = region.trim().toLocaleLowerCase();
  const fallback = ruleRealmFallback(realm);
  let index: RealmIndex;
  try {
    index = await getCachedOrFetch<RealmIndex>(
      `realm-index:${normalizedRegion}`,
      ttl(REALM_INDEX_TTL_MS),
      () => fetchRealmIndex(normalizedRegion),
    );
  } catch (error) {
    logger.warn(
      'Blizzard',
      `Could not fetch ${normalizedRegion} realm index; using fallback for ${realm}: ${error}`,
    );
    return fallback;
  }

  const folded = foldRealm(realm);
  const match = index.realms?.find(
    (candidate) =>
      Boolean(candidate.slug) &&
      (foldRealm(candidate.name ?? '') === folded || foldRealm(candidate.slug ?? '') === folded),
  );
  if (match?.slug) return match.slug;

  logger.warn(
    'Blizzard',
    `Realm ${realm} was not found in the ${normalizedRegion} realm index; using ${fallback}`,
  );
  return fallback;
}

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
  const realmSlug = encodeURIComponent(await resolveRealmSlug(region, realm));
  const url =
    `https://${region}.api.blizzard.com/profile/wow/character/` +
    `${realmSlug}/${encodeURIComponent(name.toLowerCase())}/equipment` +
    `?namespace=profile-${region}&locale=en_GB`;

  return httpRequest<BlizzardEquipmentProfile>('blizzard', url, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

interface AchievementsProfile {
  achievements?: { id: number; completed_timestamp?: number }[];
}

/** Cache wire format. A Map JSON.stringifies to `{}`, so entries are stored. */
type FingerprintEntries = [number, number][];

/**
 * Achievement timestamps are immutable once earned, so the only staleness is a
 * character earning more — correctness alone would tolerate a much longer TTL.
 *
 * 48 hours is a DISK-PRESSURE limit, not a freshness one. DO NOT RAISE IT BACK
 * TO A WEEK without re-doing this arithmetic, measured on the test bot: 1,775
 * cached fingerprints took the database from ~15 MB to 108 MB (~82 KB each as
 * raw JSON) against a 434 MB volume. At the 3,000-character cap that is ~235 MB
 * for a single applicant, so two inside the TTL window would fill the volume —
 * and exhausting it fails EVERY SQLite write in the bot, not just this feature's.
 * Compression (see encodeFingerprint) cuts that to roughly 98 MB; the TTL is the
 * other half of keeping it bounded.
 *
 * `dailyBackup` is NOT part of this problem: it writes to
 * `resolve(process.cwd(), 'backups')`, the container's ephemeral filesystem,
 * not the mounted volume.
 *
 * 48 hours still delivers what the cache is actually for: a recruitment burst
 * shares warm guild rosters across applicants, which happens within a day or
 * two, not across a week.
 */
export const FINGERPRINT_TTL_MS = 48 * 60 * 60 * 1000;

/**
 * Rosters change slowly — new members trickle in, few leave same-day — so a
 * day-long TTL costs at most one wasted fingerprint fetch on a stale member,
 * against re-walking every applicant's guild from scratch.
 */
export const GUILD_ROSTER_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * A fingerprint is the single bulkiest thing this bot caches — thousands of
 * `[achievementId, timestamp]` pairs — and it is cached per character across a
 * whole guild roster, so the raw JSON dominates the volume (see
 * FINGERPRINT_TTL_MS for the measured figures). gzip gets ~3.3x on real
 * payloads; base64 gives a third of that back to keep it a JSON-safe string in
 * the shared `api_cache` TEXT column, for a net ~2.4x.
 */
function encodeFingerprint(entries: FingerprintEntries): string {
  return gzipSync(Buffer.from(JSON.stringify(entries), 'utf8')).toString('base64');
}

/**
 * Entries cached before compression landed are a plain array, so they stay
 * readable until their TTL expires rather than needing a cache flush on deploy.
 */
function decodeFingerprint(cached: string | FingerprintEntries): FingerprintEntries {
  if (Array.isArray(cached)) return cached;
  return JSON.parse(
    gunzipSync(Buffer.from(cached, 'base64')).toString('utf8'),
  ) as FingerprintEntries;
}

/** Throws on any failure so nothing is cached; the caller decides what is fatal. */
async function fetchFingerprintEntries(c: RaiderIoCharacter): Promise<FingerprintEntries> {
  const token = await getAccessToken();
  const realmSlug = encodeURIComponent(c.realm);
  const url =
    `https://${c.region}.api.blizzard.com/profile/wow/character/` +
    `${realmSlug}/${encodeURIComponent(c.name.toLowerCase())}/achievements` +
    `?namespace=profile-${c.region}&locale=en_GB`;

  const data = await httpRequest<AchievementsProfile>('blizzard', url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const entries: FingerprintEntries = [];
  for (const a of data.achievements ?? []) {
    if (a.completed_timestamp) entries.push([a.id, a.completed_timestamp]);
  }
  return entries;
}

export interface BlizzardRosterMember {
  name: string;
  realm: string;
}

interface GuildRosterProfile {
  members?: { character?: { name?: string; realm?: { slug?: string } } }[];
}

/** Throws on any failure so nothing is cached; the caller decides what is fatal. */
async function fetchGuildRosterMembers(
  region: string,
  guildRealm: string,
  guildName: string,
): Promise<BlizzardRosterMember[]> {
  const token = await getAccessToken();
  const realmSlug = encodeURIComponent(guildRealm);
  const nameSlug = encodeURIComponent(guildNameSlug(guildName));
  const url =
    `https://${region}.api.blizzard.com/data/wow/guild/${realmSlug}/${nameSlug}/roster` +
    `?namespace=profile-${region}&locale=en_GB`;

  const data = await httpRequest<GuildRosterProfile>('blizzard', url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return (data.members ?? [])
    .map((m) => m.character)
    .filter((c): c is NonNullable<typeof c> => Boolean(c?.name && c.realm?.slug))
    .map((c) => ({ name: c.name!, realm: c.realm!.slug! }));
}

/**
 * Every member of a guild, cached per guild for GUILD_ROSTER_TTL_MS.
 *
 * Blizzard returns roughly twice what Raider.IO's member list does, because
 * Raider.IO only knows characters it has crawled — 624 vs 312 on one guild, 688 vs
 * 420 on another. The fingerprint sweep is roster-driven, so this doubles its reach
 * for one extra request per guild. Note: each member's realm is a Blizzard slug
 * (lowercase, hyphenated, e.g. `argent-dawn`) — not Raider.IO's display-name casing.
 *
 * A guild that cannot be read yields an empty array rather than throwing: one bad
 * guild must not abort the sweep of the others. A 429 or an open circuit still
 * propagates, so the job runner can pause. The failure is deliberately NOT cached —
 * caching it would freeze a transient 500 into "this guild has no members" for the
 * full TTL, so the fetcher throws and the try/catch sits outside getCachedOrFetch.
 */
export async function getBlizzardGuildRoster(
  region: string,
  guildRealm: string,
  guildName: string,
): Promise<BlizzardRosterMember[]> {
  const realmSlug = await resolveRealmSlug(region, guildRealm);
  const nameSlug = guildNameSlug(guildName);
  const key = `guild-roster:${region}:${realmSlug}:${nameSlug}`;

  try {
    return await getCachedOrFetch<BlizzardRosterMember[]>(key, ttl(GUILD_ROSTER_TTL_MS), () =>
      fetchGuildRosterMembers(region, realmSlug, guildName),
    );
  } catch (error) {
    // status alone is insufficient: httpRequest's retry-exhaustion path
    // reports the LAST status seen, so a 429 on early attempts followed by a
    // 503 on the final one throws with status 503 even though the run was
    // rate-limited. retryAfterMs is set whenever any attempt was rate-limited
    // with a usable wait, so it catches the mixed case status===429 misses.
    if (error instanceof HttpError && (error.status === 429 || error.retryAfterMs !== undefined)) {
      throw error;
    }
    if (error instanceof CircuitOpenError) throw error;
    return [];
  }
}

/**
 * The character's completed achievements as id -> timestamp, cached per
 * character for FINGERPRINT_TTL_MS. Returns null when the character cannot be
 * read (404, private, below the achievement floor) — null means "unknown", and
 * callers must not treat it as "no match".
 *
 * A 429 or open circuit is RETHROWN, not swallowed: the job runner pauses and
 * resumes on those, and turning a rate limit into null would report an
 * account as having no alts. Neither case is cached, so a retry re-fetches.
 *
 * An empty-but-successful fetch IS cached — "this character has earned no
 * achievements" is a real answer, and the TTL bounds how long it lasts.
 */
export async function getCharacterFingerprint(c: RaiderIoCharacter): Promise<Fingerprint | null> {
  const realmSlug = await resolveRealmSlug(c.region, c.realm);
  const normalized = { ...c, realm: realmSlug };
  const key = `fingerprint:${c.region}:${realmSlug}:${c.name.toLowerCase()}`;

  let entries: FingerprintEntries;
  try {
    const cached = await getCachedOrFetch<string | FingerprintEntries>(
      key,
      ttl(FINGERPRINT_TTL_MS),
      async () => encodeFingerprint(await fetchFingerprintEntries(normalized)),
    );
    entries = decodeFingerprint(cached);
  } catch (error) {
    if (error instanceof CircuitOpenError) throw error;
    // status alone is insufficient: httpRequest's retry-exhaustion path
    // reports the LAST status seen, so a 429 on early attempts followed by a
    // 503 on the final one throws with status 503 even though the run was
    // rate-limited. retryAfterMs is set whenever any attempt was rate-limited
    // with a usable wait, so it catches the mixed case status===429 misses.
    if (error instanceof HttpError && (error.status === 429 || error.retryAfterMs !== undefined)) {
      throw error;
    }
    return null;
  }

  return entries.length > 0 ? new Map(entries) : null;
}

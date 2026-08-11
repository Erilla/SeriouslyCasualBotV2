import { gunzipSync, gzipSync } from 'zlib';
import { config } from '../config.js';
import { httpRequest, CircuitOpenError, HttpError } from './httpClient.js';
import { getCachedOrFetch, ttl } from './apiCache.js';
import { logger } from './logger.js';
import type { RaiderIoCharacter } from '../functions/applications/characterLinks.js';
import type { Fingerprint } from '../functions/applications/alts/compareFingerprints.js';
import type { FingerprintEntries } from '../types/index.js';

export type { FingerprintEntries } from '../types/index.js';

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

// `normalizeRealmSlug` (space-to-hyphen, lowercase) lived here as the synchronous
// stand-in for the alt sweep's keys and was removed with #88: it was neither a key
// that the three realm vocabularies agreed on nor a slug any API accepts, and being
// exported it kept getting reached for. Use foldRealmKey for identity keys,
// resolveRealmSlug for Blizzard calls, raiderIoRealmSlug for Raider.IO ones.

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

/**
 * The one spelling of a realm that every vocabulary agrees on — letters and digits
 * only, accents folded away.
 *
 * Three vocabularies reach the alt sweep and none of them is a superset of the
 * others: Raider.IO slugs from URLs and its APIs (`azjol-nerub`, `zuljin`), Raider.IO
 * *display names* from claimed characters and guild lookups (`Azjol-Nerub`,
 * `Zul'jin`), and Blizzard slugs from guild rosters (`azjolnerub`, `zuljin`).
 * Blizzard deletes a hyphen it reads as part of the name where Raider.IO keeps it, so
 * no rule rewrites one into another without the realm index — but discarding every
 * separator collapses all three, which is all an identity key needs.
 *
 * Verified against Blizzard's realm index for eu/us/kr/tw (798 realms): the display
 * name and the slug fold to the same value for every realm, and no two distinct
 * realms share a fold. So this is safe to key on and cannot merge two real realms.
 *
 * For keys only. It is not a slug and must never be sent to an API — see
 * resolveRealmSlug for Blizzard's vocabulary and raiderIoRealmSlug for Raider.IO's.
 */
export function foldRealmKey(realm: string): string {
  return foldRealm(realm);
}

/**
 * Raider.IO's realm vocabulary, derived from a realm's display name.
 *
 * Differs from Blizzard's slug in one respect that matters: a literal hyphen in the
 * name survives (`Azjol-Nerub` -> `azjol-nerub`, where Blizzard gives `azjolnerub`),
 * and accents are kept (`Aggra (Português)` -> `aggra-português`). Apostrophes and
 * brackets are dropped and spaces become hyphens, as in both vocabularies.
 *
 * Across eu/us/kr/tw the only *live* realms where this disagrees with the Blizzard
 * slug are Azjol-Nerub (eu and us) and Arak-arahm (eu); the rest of the divergence is
 * Blizzard's internal test realms (`*-INST`, `GMSupport …`, `zzz_…`). Small, but a
 * finding stored under `azjolnerub` cannot be read back from Raider.IO at all, which
 * costs it its class and guild.
 */
export function raiderIoRealmSlug(displayName: string): string {
  return displayName
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
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

/**
 * The realm index entry for any spelling of a realm — display name, Blizzard slug or
 * Raider.IO slug — matched on the fold the three vocabularies share.
 *
 * Returns null when the index cannot be read or holds no such realm; both are the
 * caller's cue to fall back to a rule rather than to fail, since a realm the index
 * does not know is still very often usable as given.
 */
async function findRealm(
  region: string,
  realm: string,
): Promise<{ name?: string; slug?: string } | null> {
  let index: RealmIndex;
  try {
    index = await getCachedOrFetch<RealmIndex>(
      `realm-index:${region}`,
      ttl(REALM_INDEX_TTL_MS),
      () => fetchRealmIndex(region),
    );
  } catch (error) {
    logger.warn(
      'Blizzard',
      `Could not fetch ${region} realm index; using fallback for ${realm}: ${error}`,
    );
    return null;
  }

  const folded = foldRealm(realm);
  return (
    index.realms?.find(
      (candidate) =>
        Boolean(candidate.slug) &&
        (foldRealm(candidate.name ?? '') === folded || foldRealm(candidate.slug ?? '') === folded),
    ) ?? null
  );
}

/** Resolve either a realm display name or an API slug to Blizzard's canonical slug. */
export async function resolveRealmSlug(region: string, realm: string): Promise<string> {
  const normalizedRegion = region.trim().toLocaleLowerCase();
  const fallback = ruleRealmFallback(realm);

  const match = await findRealm(normalizedRegion, realm);
  if (match?.slug) return match.slug;

  logger.warn(
    'Blizzard',
    `Realm ${realm} was not found in the ${normalizedRegion} realm index; using ${fallback}`,
  );
  return fallback;
}

/**
 * Resolve any spelling of a realm to **Raider.IO's** slug, via the display name
 * Blizzard's realm index holds for it.
 *
 * This is the reverse direction from resolveRealmSlug, and it exists because a
 * Blizzard slug cannot be rewritten into a Raider.IO one by rule: `azjolnerub` gives
 * no clue where the hyphen belonged. The index supplies the display name, and
 * raiderIoRealmSlug re-derives the Raider.IO spelling from that.
 *
 * Falls back to the input, lowercased and space-hyphenated: for every realm but the
 * handful where the vocabularies diverge, a Blizzard slug already *is* the Raider.IO
 * slug, so an unreadable index costs nothing on the common path.
 */
export async function resolveRaiderIoRealm(region: string, realm: string): Promise<string> {
  const normalizedRegion = region.trim().toLocaleLowerCase();

  const match = await findRealm(normalizedRegion, realm);
  if (match?.name) return raiderIoRealmSlug(match.name);

  return ruleRealmFallback(realm);
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
export function encodeFingerprint(entries: FingerprintEntries): string {
  return gzipSync(Buffer.from(JSON.stringify(entries), 'utf8')).toString('base64');
}

/**
 * Entries cached before compression landed are a plain array, so they stay
 * readable until their TTL expires rather than needing a cache flush on deploy.
 */
export function decodeFingerprint(cached: string | FingerprintEntries): FingerprintEntries {
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
  // Both halves of the key are normalized, not just the realm: resolveRealmSlug
  // lowercases the region internally, so keying on the raw value would let "EU"
  // and "eu" hold separate 85 KB entries for one character and fetch it twice.
  const region = c.region.trim().toLocaleLowerCase();
  const realmSlug = await resolveRealmSlug(region, c.realm);
  const normalized = { ...c, region, realm: realmSlug };
  const key = `fingerprint:${region}:${realmSlug}:${c.name.toLowerCase()}`;

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

import { logger } from '../../../services/logger.js';
import { mapLimit } from '../../../utils/concurrency.js';
import { CircuitOpenError, HttpError } from '../../../services/httpClient.js';
import { normalizeRealmSlug } from '../../../services/blizzard.js';
import { compareFingerprints, type Fingerprint } from './compareFingerprints.js';
import { addFinding, isScanned, markScanned, type IntelFinding } from '../intel/jobStore.js';
import type { RaiderIoCharacter } from '../raiderIoName.js';
import type { CharacterGuild, CharacterSummary } from '../../../services/raiderio.js';
import type {
  CharacterOwner,
  ClaimedCharacter,
  MythicKillDate,
} from '../../../services/raiderioInternal.js';

/**
 * Caps and concurrency for the sweep.
 *
 * With Blizzard rosters (~twice Raider.IO's member count) 12 guilds hold ~7,200
 * candidates, so `characters` binds rather than acting as a safety net — which is
 * intended. 3,000 fingerprints is 8% of Blizzard's 36,000/hour budget; measured
 * throughput at concurrency 8 was 313 characters in 13s ≈ 24 req/s, well under the
 * 100/s ceiling. The budget is HOURLY, not per job: four applicants at the cap in
 * one hour is ~33% of it, so raising these numbers trades reach for other
 * applicants' sweeps pausing.
 */
export const ALT_CAPS = {
  guilds: 12,
  characters: 3000,
  depth: 3,
  concurrency: 8,
} as const;

export interface RosterMember {
  name: string;
  realm: string;
}

/** Injected so the BFS can be tested without network access. */
export interface DiscoverDeps {
  getCharacterOwner: (c: RaiderIoCharacter) => Promise<CharacterOwner | null>;
  getClaimedCharacters: (user: string) => Promise<ClaimedCharacter[]>;
  getCharacterSummary: (c: RaiderIoCharacter) => Promise<CharacterSummary | null>;
  getCharacterGuild: (c: RaiderIoCharacter) => Promise<CharacterGuild | null>;
  getGuildRoster: (guild: CharacterGuild) => Promise<RosterMember[]>;
  getCharacterFingerprint: (c: RaiderIoCharacter) => Promise<Fingerprint | null>;
  /** Kill history, used here only for the guilds it names. */
  getMythicKillDates: (
    c: RaiderIoCharacter,
    tierOrdinals: number[],
  ) => Promise<MythicKillDate[] | null>;
  tierOrdinals: number[];
  /** Pace between internal-API calls; 0 in tests. */
  paceMs?: number;
  maxGuilds?: number;
  maxCharacters?: number;
  maxDepth?: number;
}

// The four sources disagree on realm format: application/declared-main/fingerprint
// characters carry a slug (e.g. "argent-dawn"), but claimed characters come from
// Raider.IO's internal API as `ch.realm.name`, a display name (e.g. "Outland").
// The findings table's primary key is case-sensitive, so every finding must be
// normalised to the same slug before it is recorded or looked up, or the same
// character lands on two rows depending on which source found it first.
const key = (name: string, realm: string): string =>
  `${name}-${normalizeRealmSlug(realm)}`.toLowerCase();
const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();

/**
 * Find every character on the applicant's account.
 *
 * Three sources compose rather than compete: the declared main and the owner's
 * claimed-character list are authoritative but often unavailable (four of five
 * live characters tested had the owner privacy-hidden), while the achievement
 * fingerprint always works but only sees shared guilds. Seeding the BFS from
 * EVERY guild the first two sources reveal is what lets the fingerprint reach
 * beyond the applicant's own guild.
 */
export async function discoverAlts(
  jobId: number,
  applicants: RaiderIoCharacter[],
  deps: DiscoverDeps,
): Promise<{ truncated: boolean }> {
  const maxGuilds = deps.maxGuilds ?? ALT_CAPS.guilds;
  const maxCharacters = deps.maxCharacters ?? ALT_CAPS.characters;
  const maxDepth = deps.maxDepth ?? ALT_CAPS.depth;
  const pace = deps.paceMs ?? 0;

  // Nothing may fail an application: an empty applicant list has no primary to
  // fingerprint against and no work to do.
  if (applicants.length === 0) return { truncated: false };

  const primary = applicants[0];
  const known = new Map<string, RaiderIoCharacter>();
  const guildFrontier: { guild: CharacterGuild; depth: number }[] = [];
  const visitedGuilds = new Set<string>();
  let truncated = false;

  async function record(
    c: RaiderIoCharacter,
    source: IntelFinding['source'],
    confidence: number | null,
  ): Promise<void> {
    const realm = normalizeRealmSlug(c.realm);
    const normalized: RaiderIoCharacter = { ...c, realm };
    known.set(key(c.name, c.realm), normalized);
    const summary = await deps.getCharacterSummary(normalized);
    addFinding(jobId, {
      name: normalized.name,
      realm,
      className: summary?.className ?? null,
      guildName: summary?.guild?.name ?? null,
      guildRealm: summary?.guild?.realm ?? null,
      source,
      confidence,
      // The confirmation pass fills these in afterwards.
      discordStatus: null,
      discordProfile: null,
    });
    if (summary?.guild) {
      const gk = key(summary.guild.name, summary.guild.realm);
      if (
        !visitedGuilds.has(gk) &&
        !guildFrontier.some((g) => key(g.guild.name, g.guild.realm) === gk)
      ) {
        guildFrontier.push({ guild: summary.guild, depth: 0 });
      }
    }
  }

  // Source 0: every character the applicant named themselves.
  for (const c of applicants) await record(c, 'application', null);

  // Sources 1 and 2: declared main, then the owner's claimed-character list.
  for (const c of applicants) {
    const owner = await deps.getCharacterOwner(c);
    await sleep(pace);
    if (!owner) continue;

    if (owner.declaredMain && !known.has(key(owner.declaredMain.name, owner.declaredMain.realm))) {
      await record(owner.declaredMain, 'declared main', 100);
    }

    if (owner.user) {
      const claimed = await deps.getClaimedCharacters(owner.user);
      await sleep(pace);
      for (const ch of claimed) {
        if (known.has(key(ch.name, ch.realm))) continue;
        await record({ region: c.region, realm: ch.realm, name: ch.name }, 'raider.io', 100);
      }
    }
  }

  // Seed any guild we have not already queued from the applicants themselves.
  for (const c of applicants) {
    const guild = await deps.getCharacterGuild(c);
    if (!guild) continue;
    const gk = key(guild.name, guild.realm);
    if (
      !visitedGuilds.has(gk) &&
      !guildFrontier.some((g) => key(g.guild.name, g.guild.realm) === gk)
    ) {
      guildFrontier.push({ guild, depth: 0 });
    }
  }

  // FORMER guilds too: every guild named in a known character's kill history.
  // Alts are routinely left behind in a guild the main has since left, and no
  // other readable source reveals those guilds. The data rides along with the
  // kill dates, so it costs nothing extra.
  for (const c of [...known.values()]) {
    const history = await deps.getMythicKillDates(c, deps.tierOrdinals);
    await sleep(pace);
    if (!history) continue;
    for (const past of history) {
      if (!past.guild) continue;
      const pk = key(past.guild.name, past.guild.realm);
      if (visitedGuilds.has(pk)) continue;
      if (guildFrontier.some((g) => key(g.guild.name, g.guild.realm) === pk)) continue;
      guildFrontier.push({ guild: past.guild, depth: 0 });
    }
  }

  // Source 3: fingerprint every roster member of every associated guild.
  //
  // A null applicant fingerprint is UNKNOWN, not a signal to abandon the sweep:
  // the guilds already surfaced by sources 1/2 (declared main, claimed list, own
  // guild, kill history) are still worth walking — the roster fetches warm the
  // guild-roster cache for a resumed run — but this run cannot identify NEW
  // characters via fingerprint match, so every comparison in this walk is work
  // left undone. Report that honestly rather than letting an empty frontier or
  // an unmet cap read as "nothing to find here".
  const applicantFingerprint = await deps.getCharacterFingerprint(primary);
  if (!applicantFingerprint) {
    logger.warn(
      'Alts',
      `No fingerprint for ${primary.name}-${primary.realm}; guilds will be walked without matching`,
    );
    // No comparison can happen this run, so every candidate below is work left
    // undone by definition — an empty frontier or an unmet cap must never make
    // that read as "nothing to find here".
    truncated = true;
  }
  // Characters already recorded via a stronger source (application/declared
  // main/claimed list) never need a fingerprint fetch even if a roster surfaces
  // them again — this is independent of whether the applicant's own fingerprint
  // is available.
  for (const c of known.values()) markScanned(jobId, key(c.name, c.realm));

  let fingerprinted = 0;
  while (guildFrontier.length > 0 && visitedGuilds.size < maxGuilds) {
    const entry = guildFrontier.shift()!;
    const gk = key(entry.guild.name, entry.guild.realm);
    if (visitedGuilds.has(gk)) continue;
    visitedGuilds.add(gk);

    // A guild's realm is its own, frequently not the character's.
    const roster = await deps.getGuildRoster(entry.guild);
    // A single roster can list the same character more than once; dedupe by key
    // so mapLimit never queues two concurrent fingerprint calls for it — markScanned
    // only lands *inside* the callback, too late to stop a duplicate already queued.
    const seen = new Set<string>();
    const pending = roster.filter((m) => {
      const mk = key(m.name, m.realm);
      if (isScanned(jobId, mk) || seen.has(mk)) return false;
      seen.add(mk);
      return true;
    });

    const budget = maxCharacters - fingerprinted;
    if (pending.length > budget) truncated = true;
    const batch = pending.slice(0, Math.max(0, budget));
    fingerprinted += batch.length;

    const matches = applicantFingerprint
      ? await mapLimit(batch, ALT_CAPS.concurrency, async (member) => {
          const candidate: RaiderIoCharacter = {
            region: primary.region,
            realm: member.realm,
            name: member.name,
          };
          let fingerprint: Fingerprint | null;
          try {
            fingerprint = await deps.getCharacterFingerprint(candidate);
          } catch (error) {
            // A rate limit or an open circuit is not "no alts" — it must propagate
            // so the job runner pauses and resumes this member later. Swallowing it
            // here would both under-report and (since markScanned only runs below,
            // on a determinate outcome) permanently mark the member scanned despite
            // never having been compared.
            if (
              error instanceof CircuitOpenError ||
              (error instanceof HttpError &&
                (error.status === 429 || error.retryAfterMs !== undefined))
            ) {
              throw error;
            }
            // Genuinely unavailable (404/403/500/etc.) — UNKNOWN, never a non-match.
            fingerprint = null;
          }
          // Only a determinate outcome (matched, didn't match, or unavailable-but-
          // not-rate-limited) may mark a member scanned; never before the fetch.
          markScanned(jobId, key(member.name, member.realm));
          if (!fingerprint) return null;
          const result = compareFingerprints(applicantFingerprint, fingerprint);
          return result.isMatch ? { candidate, percent: result.percent } : null;
        })
      : batch.map(() => null);

    for (const match of matches) {
      if (!match) continue;
      if (known.has(key(match.candidate.name, match.candidate.realm))) continue;
      await record(match.candidate, 'fingerprint', Math.round(match.percent));
      if (entry.depth + 1 < maxDepth) {
        const guild = await deps.getCharacterGuild(match.candidate);
        if (guild && !visitedGuilds.has(key(guild.name, guild.realm))) {
          guildFrontier.push({ guild, depth: entry.depth + 1 });
        }
      }
    }

    if (fingerprinted >= maxCharacters) {
      truncated = true;
      break;
    }
  }

  if (guildFrontier.length > 0) truncated = true;
  return { truncated };
}

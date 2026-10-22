import { getRaidStaticData, getRaidRankings } from './raiderio.js';
import { logger } from './logger.js';

// Same walk checkRaidExpansions uses: raider.io static data has no "current
// expansion" endpoint, so probe upward from a known floor until the API 400s.
const START_EXPANSION = 9;

export interface ProgressionContext {
  mode: 'progress' | 'reclear';
  raidName: string;
  /**
   * In 'progress' mode: the current prog boss. In 'reclear' mode: the end boss
   * (kept for callers that want it; the reclear prompt deliberately does not
   * name a dead boss).
   */
  bossName: string;
  killed: number;
  total: number;
}

// Overall ceiling on the progression lookup. The walk makes several
// sequential raider.io calls and the shared http client retries with
// backoff — without a deadline a hanging (not failing) raider.io could
// stall the signup alert for minutes.
const LOOKUP_DEADLINE_MS = 10_000;

/**
 * Derive the guild's current Mythic progression from raider.io for quip
 * flavour. Best-effort only: any API failure, missing current raid, empty
 * rankings (fresh tier), or exceeding the overall lookup deadline returns
 * null — the quip must never fail or block on raider.io.
 */
export async function getProgressionContext(): Promise<ProgressionContext | null> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      logger.debug(
        'QuipContext',
        `Progression lookup exceeded ${LOOKUP_DEADLINE_MS}ms, omitting context`,
      );
      resolve(null);
    }, LOOKUP_DEADLINE_MS);
  });
  try {
    return await Promise.race([lookupProgression(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function lookupProgression(): Promise<ProgressionContext | null> {
  try {
    const currentRaid = await findCurrentRaid();
    if (!currentRaid) {
      logger.debug('QuipContext', 'No current raid found in static data');
      return null;
    }

    const rankings = await getRaidRankings(currentRaid.slug);
    if (!rankings || rankings.length === 0) {
      logger.debug('QuipContext', `No rankings for ${currentRaid.slug} (fresh tier?)`);
      return null;
    }

    // encountersDefeated is typed as a number but the API has been observed
    // returning an array — same guard as updateAchievements.
    const defeatedCount = (entry: (typeof rankings)[number]): number => {
      const val = entry.encountersDefeated as unknown;
      if (Array.isArray(val)) return val.length;
      if (typeof val === 'number') return val;
      return 0;
    };

    const best = rankings.reduce(
      (a, b) => (defeatedCount(b) > defeatedCount(a) ? b : a),
      rankings[0],
    );
    const killed = defeatedCount(best);
    const total =
      typeof best.encountersTotal === 'number' && best.encountersTotal > 0
        ? best.encountersTotal
        : currentRaid.encounters.length;

    if (killed >= total) {
      const endBoss = currentRaid.encounters[currentRaid.encounters.length - 1];
      if (!endBoss) return null;
      return { mode: 'reclear', raidName: currentRaid.name, bossName: endBoss.name, killed, total };
    }

    // Static-data encounters are in kill order, so the prog boss is the
    // first undefeated one.
    const progBoss = currentRaid.encounters[killed];
    if (!progBoss) return null;
    return { mode: 'progress', raidName: currentRaid.name, bossName: progBoss.name, killed, total };
  } catch (err) {
    logger.debug(
      'QuipContext',
      `Progression lookup failed, omitting context: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

type StaticRaid = Awaited<ReturnType<typeof getRaidStaticData>>['raids'][number];

function euStartTime(raid: StaticRaid): number {
  // No announced start yet (or an unparseable one): treat the raid as already
  // open, so a tier that has launched but not been dated by raider.io still
  // counts.
  if (!raid.starts.eu) return 0;
  const parsed = new Date(raid.starts.eu).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function euEndTime(raid: StaticRaid): number {
  // Raider.io uses 2030-01-01 as the "no announced end" sentinel for every
  // concurrently-active raid (the main tier and each one-boss side raid), so
  // end dates cannot distinguish them. Missing/unparseable ends are treated
  // as open-ended for the same reason.
  if (!raid.ends.eu) return Infinity;
  const parsed = new Date(raid.ends.eu).getTime();
  return Number.isNaN(parsed) ? Infinity : parsed;
}

/**
 * Raider.io gives the main tier and every concurrently-active side raid the
 * same far-future sentinel end date, so "first active raid" is just API order
 * and tends to land on a one-boss side raid the guild already cleared. The
 * main tier is the active raid with the most encounters; ties go to the most
 * recently released raid, then slug for determinism.
 */
function isBetterMainTier(raid: StaticRaid, best: StaticRaid): boolean {
  if (raid.encounters.length !== best.encounters.length) {
    return raid.encounters.length > best.encounters.length;
  }

  const raidStart = euStartTime(raid);
  const bestStart = euStartTime(best);
  if (raidStart !== bestStart) return raidStart > bestStart;

  return raid.slug < best.slug;
}

async function findCurrentRaid(): Promise<StaticRaid | null> {
  let expansion = START_EXPANSION;
  let currentRaid: StaticRaid | null = null;

  // Keep scanning until the API errors (unknown expansion) so we end up with
  // the newest expansion's current tier, not an old expansion's.
  for (;;) {
    let staticData;
    try {
      staticData = await getRaidStaticData(expansion);
    } catch {
      break;
    }

    if ((staticData.raids ?? []).length === 0) break;

    const now = Date.now();
    const active = (staticData.raids ?? []).filter(
      (r) =>
        !r.name.startsWith('Fated') &&
        !r.name.startsWith('Awakened') &&
        euStartTime(r) <= now &&
        euEndTime(r) > now,
    );
    if (active.length > 0) {
      currentRaid = active.reduce((best, raid) => (isBetterMainTier(raid, best) ? raid : best));
    }

    expansion++;
  }

  return currentRaid;
}

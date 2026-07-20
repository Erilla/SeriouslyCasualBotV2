import { getRaidStaticData, getRaidRankings } from './raiderio.js';
import { logger } from './logger.js';

// Same walk checkRaidExpansions uses: raider.io static data has no "current
// expansion" endpoint, so probe upward from a known floor until the API 400s.
const START_EXPANSION = 9;

export interface ProgressionContext {
  mode: 'progress' | 'reclear';
  raidName: string;
  /** In 'progress' mode: the current prog boss. In 'reclear' mode: the dead end boss. */
  bossName: string;
  killed: number;
  total: number;
}

/**
 * Derive the guild's current Mythic progression from raider.io for quip
 * flavour. Best-effort only: any API failure, missing current raid, or empty
 * rankings (fresh tier) returns null — the quip must never fail or block on
 * raider.io.
 */
export async function getProgressionContext(): Promise<ProgressionContext | null> {
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

    const best = rankings.reduce((a, b) => (defeatedCount(b) > defeatedCount(a) ? b : a), rankings[0]);
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

    const now = Date.now();
    const candidates = (staticData.raids ?? [])
      .filter((r) => !r.name.startsWith('Fated') && !r.name.startsWith('Awakened'))
      .sort((a, b) => {
        const aEnd = a.ends.eu ? new Date(a.ends.eu).getTime() : Infinity;
        const bEnd = b.ends.eu ? new Date(b.ends.eu).getTime() : Infinity;
        return aEnd - bEnd;
      });
    const found = candidates.find((r) => r.ends.eu === null || new Date(r.ends.eu).getTime() > now);
    if (found) currentRaid = found;

    expansion++;
  }

  return currentRaid;
}

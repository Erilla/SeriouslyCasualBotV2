import type { WclEncounter, WclZone } from './zoneCatalogue.js';

export const MAX_LINES_PER_TIER = 3;

export interface SweepCandidate {
  name: string;
  realm: string;
  /** Current-expansion Mythic kills from Raider.IO — a prioritiser, not a gate. */
  mythicKills: number;
  /** WCL zone ids this character has raid reports in. */
  tiers: number[];
}

export const characterKey = (name: string, realm: string): string =>
  `${name}-${realm}`.toLowerCase();

/**
 * Which characters get a full WCL sweep: every character named in the
 * application (always, exempt from the slots), then Mythic-kill characters
 * ranked by kill count, then greedy tier coverage for the remaining slots.
 *
 * Coverage rather than recency: on a live account the four most recent alts had
 * all raided the same tier as the main, so recency spent two sweeps to learn
 * nothing, while coverage surfaced an extra expansion's progression.
 */
export function selectSweepTargets(
  applicantKeys: string[],
  candidates: SweepCandidate[],
  slots: number,
): string[] {
  const chosen = [...applicantKeys];
  const taken = new Set(chosen);
  const covered = new Set<number>();

  const withKills = candidates
    .filter((c) => c.mythicKills > 0 && !taken.has(characterKey(c.name, c.realm)))
    .sort((a, b) => b.mythicKills - a.mythicKills);

  for (const c of withKills) {
    if (chosen.length - applicantKeys.length >= slots) break;
    const key = characterKey(c.name, c.realm);
    chosen.push(key);
    taken.add(key);
    for (const t of c.tiers) covered.add(t);
  }

  while (chosen.length - applicantKeys.length < slots) {
    let best: SweepCandidate | null = null;
    let bestNew = 0;
    for (const c of candidates) {
      if (taken.has(characterKey(c.name, c.realm))) continue;
      const fresh = c.tiers.filter((t) => !covered.has(t)).length;
      if (fresh > bestNew) {
        best = c;
        bestNew = fresh;
      }
    }
    if (!best) break;
    const key = characterKey(best.name, best.realm);
    chosen.push(key);
    taken.add(key);
    for (const t of best.tiers) covered.add(t);
  }

  return chosen;
}

const normalise = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Map a Raider.IO boss name onto a WCL encounter. The two sources genuinely
 * disagree — Raider.IO says "Dimensius", WCL says "Dimensius, the
 * All-Devouring" — and share no identifier, so this is prefix matching with a
 * uniqueness requirement. An ambiguous or unknown name returns null, and the
 * caller renders the line without a date rather than dropping the boss.
 */
export function matchBossName(zone: WclZone, raiderIoName: string): WclEncounter | null {
  const needle = normalise(raiderIoName);
  if (!needle) return null;

  const exact = zone.encounters.find((e) => normalise(e.name) === needle);
  if (exact) return exact;

  const prefixed = zone.encounters.filter((e) => {
    const name = normalise(e.name);
    return name.startsWith(needle) || needle.startsWith(name);
  });
  return prefixed.length === 1 ? prefixed[0] : null;
}

export interface BossEvidence {
  encounterId: number;
  bossIndex: number;
  bossName: string;
  who: string;
  kind: 'kill' | 'wipe';
  /** ISO date of the first kill; absent for wipes. */
  date?: string;
  /** Best boss percentage reached; only meaningful for wipes. */
  percent?: number;
  reportCode: string;
  isApplicantCharacter: boolean;
}

/**
 * Lower is better. An undated kill (no WCL/Raider.IO name match) must sort
 * LAST among kills, never first: `?? Infinity` rather than `?? 0`, because a
 * missing date means "unknown", not "earliest" — a naming mismatch must cost
 * only a date, never the boss's attribution to whoever actually has a
 * verified earlier kill.
 */
function rank(e: BossEvidence): [number, number, number, number] {
  return [
    e.kind === 'kill' ? 0 : 1,
    e.kind === 'kill' ? (e.date ? new Date(e.date).getTime() : Infinity) : (e.percent ?? 100),
    e.isApplicantCharacter ? 0 : 1,
    e.kind === 'kill' ? 0 : -new Date(e.date ?? 0).getTime(),
  ];
}

/**
 * One entry per boss, resolved in order: a kill beats any wipe; the EARLIEST
 * kill across the account wins (a re-kill on an alt months later is not
 * progression); between two wipes the lower boss percentage wins; ties go to
 * the applicant's own character, so their line is never displaced by an alt
 * with identical evidence.
 */
export function mergeBossEvidence(candidates: BossEvidence[]): BossEvidence[] {
  const best = new Map<number, BossEvidence>();
  for (const candidate of candidates) {
    const current = best.get(candidate.encounterId);
    if (!current) {
      best.set(candidate.encounterId, candidate);
      continue;
    }
    const a = rank(candidate);
    const b = rank(current);
    for (let i = 0; i < a.length; i++) {
      if (a[i] === b[i]) continue;
      if (a[i] < b[i]) best.set(candidate.encounterId, candidate);
      break;
    }
  }
  return [...best.values()];
}

/**
 * Up to `maxLines` lines for one tier, deepest boss first, skipping any report
 * already linked for a deeper boss — one log covering bosses 6–8 is one line,
 * not three.
 */
export function selectTierLines(
  zone: WclZone,
  evidence: BossEvidence[],
  maxLines = MAX_LINES_PER_TIER,
): BossEvidence[] {
  const ranked = [...evidence].sort((a, b) => b.bossIndex - a.bossIndex);
  const seenReports = new Set<string>();
  const lines: BossEvidence[] = [];
  for (const entry of ranked) {
    if (seenReports.has(entry.reportCode)) continue;
    seenReports.add(entry.reportCode);
    lines.push(entry);
    if (lines.length >= maxLines) break;
  }
  return lines;
}

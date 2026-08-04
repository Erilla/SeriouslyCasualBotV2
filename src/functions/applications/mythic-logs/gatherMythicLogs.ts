import {
  matchBossName,
  mergeBossEvidence,
  selectTierLines,
  type BossEvidence,
} from './selectMythicReports.js';
import type { WclZone } from './zoneCatalogue.js';
import type { RaiderIoCharacter } from '../raiderIoName.js';
import type { GuildHistoryEntry, GuildStint, RenderedTier } from '../intel/render.js';
import type {
  EncounterKill,
  RaidReportRef,
  WipePull,
  ZoneKill,
} from '../../../services/warcraftlogs.js';
import type { MythicKillDate } from '../../../services/raiderioInternal.js';

export const MAX_TIERS = 5;

/**
 * Guild history, from the same kill payload the dates come from: every kill entry
 * names the guild it happened with, so this costs no extra requests.
 *
 * Raid names come from the WCL zone — `tier-mn-1` means nothing to a reviewer
 * where `VS / DR / MQD` does — falling back to Raider.IO's slug rather than
 * dropping a raid we cannot match.
 */
export function aggregateGuildHistory(
  killDates: { character: string; entries: MythicKillDate[] }[],
  zones: WclZone[],
): GuildHistoryEntry[] {
  const byGuild = new Map<
    string,
    { name: string; realm: string; raids: Map<string, GuildStint> }
  >();

  for (const { character, entries } of killDates) {
    for (const entry of entries) {
      if (!entry.guild) continue;
      const gk = `${entry.guild.name}-${entry.guild.realm}`.toLowerCase();
      const guild = byGuild.get(gk) ?? {
        name: entry.guild.name,
        realm: entry.guild.realm,
        raids: new Map<string, GuildStint>(),
      };
      byGuild.set(gk, guild);

      let raidName = entry.bossName;
      for (const zone of zones) {
        if (matchBossName(zone, entry.bossName)) {
          raidName = zone.name;
          break;
        }
      }

      // Keep the full ISO timestamp: the renderer turns it into a Discord
      // timestamp (which needs the time), and ISO strings still compare
      // lexicographically for min/max.
      const at = entry.firstDefeated;
      const stint = guild.raids.get(raidName) ?? {
        raidName,
        kills: 0,
        first: at,
        last: at,
        characters: [] as string[],
      };
      stint.kills++;
      if (at < stint.first) stint.first = at;
      if (at > stint.last) stint.last = at;
      if (!stint.characters.includes(character)) stint.characters.push(character);
      guild.raids.set(raidName, stint);
    }
  }

  const lastOf = (stints: GuildStint[]): string =>
    stints
      .map((st) => st.last)
      .sort()
      .slice(-1)[0] ?? '';

  return [...byGuild.values()]
    .map((guild) => ({
      guildName: guild.name,
      guildRealm: guild.realm,
      stints: [...guild.raids.values()].sort((a, b) => b.last.localeCompare(a.last)),
    }))
    .sort((a, b) => lastOf(b.stints).localeCompare(lastOf(a.stints)));
}
/** Reports scanned per tier when looking for a wipe on the next boss. */
const WIPE_SCAN_REPORTS = 8;

export interface GatherDeps {
  getZoneKills: (c: RaiderIoCharacter, zoneId: number) => Promise<ZoneKill[]>;
  getEncounterKills: (c: RaiderIoCharacter, encounterId: number) => Promise<EncounterKill[]>;
  getRaidReports: (c: RaiderIoCharacter, zoneIds: Set<number>) => Promise<RaidReportRef[]>;
  getReportWipes: (code: string) => Promise<WipePull[]>;
  getMythicKillDates: (
    c: RaiderIoCharacter,
    tierOrdinals: number[],
  ) => Promise<MythicKillDate[] | null>;
  tierOrdinals: number[];
  paceMs?: number;
}

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();

/**
 * Pool Mythic progression across the swept characters into at most five tiers.
 *
 * WCL decides what was killed and supplies every link (both keyed on WCL
 * encounter ids); Raider.IO only decorates a kill with its first-kill date, so
 * a naming mismatch costs a date, never a boss.
 */
export async function gatherMythicLogs(
  applicants: RaiderIoCharacter[],
  swept: RaiderIoCharacter[],
  zones: WclZone[],
  deps: GatherDeps,
): Promise<RenderedTier[]> {
  const pace = deps.paceMs ?? 0;
  const applicantNames = new Set(applicants.map((a) => a.name.toLowerCase()));
  const accountNames = new Set(swept.map((c) => c.name.toLowerCase()));
  const zoneById = new Map(zones.map((z) => [z.id, z]));

  // Raider.IO first-kill dates per character, matched onto WCL encounters.
  const datesByCharacter = new Map<string, Map<number, string>>();
  for (const c of swept) {
    const raw = await deps.getMythicKillDates(c, deps.tierOrdinals);
    await sleep(pace);
    // null means UNKNOWN — record nothing rather than "no kills", which would
    // hand first-kill credit to a different character.
    if (!raw) continue;
    const perEncounter = new Map<number, string>();
    for (const entry of raw) {
      for (const zone of zones) {
        const encounter = matchBossName(zone, entry.bossName);
        if (!encounter) continue;
        const existing = perEncounter.get(encounter.id);
        if (!existing || entry.firstDefeated < existing) {
          perEncounter.set(encounter.id, entry.firstDefeated);
        }
        break;
      }
    }
    datesByCharacter.set(c.name.toLowerCase(), perEncounter);
  }

  const evidenceByZone = new Map<number, BossEvidence[]>();

  for (const zone of zones) {
    for (const c of swept) {
      const kills = await deps.getZoneKills(c, zone.id);
      if (kills.length === 0) continue;
      const dates = datesByCharacter.get(c.name.toLowerCase());

      for (const kill of kills) {
        const index = zone.encounters.findIndex((e) => e.id === kill.encounterId);
        if (index < 0) continue;
        const reports = await deps.getEncounterKills(c, kill.encounterId);
        const first = reports[0];
        if (!first) continue;
        const list = evidenceByZone.get(zone.id) ?? [];
        list.push({
          encounterId: kill.encounterId,
          bossIndex: index,
          bossName: zone.encounters[index].name,
          who: c.name,
          kind: 'kill',
          date: dates?.get(kill.encounterId),
          reportCode: first.reportCode,
          isApplicantCharacter: applicantNames.has(c.name.toLowerCase()),
        });
        evidenceByZone.set(zone.id, list);
      }
    }
  }

  // One wipe line per tier: the boss immediately after the deepest kill.
  for (const [zoneId, evidence] of evidenceByZone) {
    const zone = zoneById.get(zoneId)!;
    const deepest = Math.max(...evidence.map((e) => e.bossIndex));
    const target = zone.encounters[deepest + 1];
    if (!target) continue;

    let found: BossEvidence | null = null;
    for (const c of swept) {
      if (found) break;
      const reports = (await deps.getRaidReports(c, new Set([zoneId])))
        .sort((a, b) => b.startTime - a.startTime)
        .slice(0, WIPE_SCAN_REPORTS);
      for (const report of reports) {
        const wipes = (await deps.getReportWipes(report.code))
          .filter((w) => w.encounterId === target.id)
          .filter((w) => w.players.some((p) => accountNames.has(p.toLowerCase())))
          .sort((a, b) => a.fightPercentage - b.fightPercentage);
        const best = wipes[0];
        if (!best) continue;
        const who = best.players.find((p) => accountNames.has(p.toLowerCase()))!;
        found = {
          encounterId: target.id,
          bossIndex: deepest + 1,
          bossName: target.name,
          who,
          kind: 'wipe',
          percent: best.fightPercentage,
          reportCode: report.code,
          isApplicantCharacter: applicantNames.has(who.toLowerCase()),
        };
        break;
      }
    }
    if (found) evidence.push(found);
  }

  const tiers: RenderedTier[] = [];
  for (const [zoneId, evidence] of evidenceByZone) {
    const zone = zoneById.get(zoneId)!;
    const lines = selectTierLines(zone, mergeBossEvidence(evidence));
    if (lines.length > 0) tiers.push({ zone, lines });
  }

  // Newest expansion content first — zone ids increase over time.
  tiers.sort((a, b) => b.zone.id - a.zone.id);
  return tiers.slice(0, MAX_TIERS);
}

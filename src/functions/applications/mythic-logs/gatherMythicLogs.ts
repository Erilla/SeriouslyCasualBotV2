import {
  matchBossName,
  mergeBossEvidence,
  selectTierLines,
  type BossEvidence,
} from './selectMythicReports.js';
import type { WclZone } from './zoneCatalogue.js';
import { mapLimit } from '../../../utils/concurrency.js';
import type { RaiderIoCharacter } from '../characterLinks.js';
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
 * Concurrent WarcraftLogs queries. WCL bills by POINTS, not requests, so raising
 * this changes only the burst rate, never the total spend — and the 90%
 * points pre-emption still guards the budget. Kept modest because a burst also
 * makes the pre-emption trip sooner within a single run.
 */
const WCL_CONCURRENCY = 6;

/** Lowercase inside a title, capitalised only when they lead it. */
const TITLE_PARTICLES = new Set(['of', 'the', 'and', 'in', 'at', 'to', 'a', 'an']);

/**
 * Best-effort display name for a Raider.IO slug used as a raid-name fallback.
 *
 * The fallback fires more often than it looks: `selectMythicRaidZones` drops
 * single-boss zones, so a one-boss raid has no WCL zone to match and its slug is
 * all we have. The live test sweep surfaced `rotmire` in the guild history for
 * exactly that reason. Dropping the raid entirely would lose real evidence, so
 * this only makes the slug readable — it never decides whether a raid appears.
 */
/**
 * Which slug to name an unmatched raid after. Raider.IO's raid slug is the right
 * answer — it groups a whole raid's bosses under one heading, so a tier older than
 * the WCL catalogue's three-expansion window reads as
 * "Sepulcher of the First Ones · 11 Mythic kills" rather than eleven one-kill rows.
 *
 * Except for the CURRENT tier, where the slug is an opaque code (`tier-mn-1`)
 * that would render as "Tier Mn 1". Those bosses are inside the catalogue window
 * and match a zone anyway, so the boss slug is the safer fallback for them.
 */
function raidSlugFor(entry: MythicKillDate): string {
  const raid = entry.raid;
  if (!raid || /^tier-/.test(raid)) return entry.bossName;
  return raid;
}

function readableRaidName(slug: string): string {
  return slug
    .split('-')
    .map((word, i) =>
      !word || (i > 0 && TITLE_PARTICLES.has(word))
        ? word
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(' ');
}

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

      let raidName = readableRaidName(raidSlugFor(entry));
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

/**
 * Tiers scanned for a wipe at once. Capped at MAX_TIERS because that is how many
 * entries the wipe scan can ever have to work through.
 */
const WIPE_ZONE_CONCURRENCY = MAX_TIERS;

export interface GatherDeps {
  getZoneKills: (c: RaiderIoCharacter, zoneId: number) => Promise<ZoneKill[]>;
  getEncounterKills: (c: RaiderIoCharacter, encounterId: number) => Promise<EncounterKill[]>;
  getRaidReports: (c: RaiderIoCharacter, zoneIds: Set<number>) => Promise<RaidReportRef[]>;
  getReportWipes: (code: string) => Promise<WipePull[]>;
  /**
   * Must do its own pacing. runJob injects a per-job memo that serves every
   * swept character from the fetch the guild-history phase already made, so
   * sleeping between calls here would be sleeping between cache hits.
   */
  getMythicKillDates: (
    c: RaiderIoCharacter,
    tierOrdinals: number[],
  ) => Promise<MythicKillDate[] | null>;
  tierOrdinals: number[];
}

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
  const applicantNames = new Set(applicants.map((a) => a.name.toLowerCase()));
  const accountNames = new Set(swept.map((c) => c.name.toLowerCase()));
  const zoneById = new Map(zones.map((z) => [z.id, z]));

  // Raider.IO first-kill dates per character, matched onto WCL encounters.
  const datesByCharacter = new Map<string, Map<number, string>>();
  for (const c of swept) {
    const raw = await deps.getMythicKillDates(c, deps.tierOrdinals);
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

  // Newest-first, same order as the final sort, and stop once MAX_TIERS zones
  // have actually produced evidence — the final slice keeps the five newest
  // zones WITH evidence, so gathering more than that is pure waste against a
  // points-billed API. A zone that yields nothing must not consume a slot.
  const zonesNewestFirst = [...zones].sort((a, b) => b.id - a.id);
  let producedZones = 0;
  for (const zone of zonesNewestFirst) {
    if (producedZones >= MAX_TIERS) break;

    // Characters within a zone run concurrently, and each character's per-boss
    // getEncounterKills calls do too. Zones stay SERIAL so the MAX_TIERS early
    // stop above still works — that saving is worth more than parallelising
    // across zones, since it avoids the WCL calls entirely rather than
    // overlapping them. Serially this was ~5 characters x (1 + ~8 bosses) x 299ms
    // ≈ 13s per zone; concurrently it is a couple of round trips.
    //
    // mapLimit preserves input order, so evidence is appended in the same
    // (character, boss) order as the serial version. That matters:
    // mergeBossEvidence breaks ties on input order, so a non-deterministic
    // append order would make the chosen line vary between runs.
    const perCharacter = await mapLimit(swept, WCL_CONCURRENCY, async (c) => {
      const kills = await deps.getZoneKills(c, zone.id);
      if (kills.length === 0) return [];
      const dates = datesByCharacter.get(c.name.toLowerCase());

      const scored = kills
        .map((kill) => ({
          kill,
          index: zone.encounters.findIndex((e) => e.id === kill.encounterId),
        }))
        .filter((k) => k.index >= 0);

      const reportsPerKill = await mapLimit(scored, WCL_CONCURRENCY, ({ kill }) =>
        deps.getEncounterKills(c, kill.encounterId),
      );

      const rows: BossEvidence[] = [];
      scored.forEach(({ kill, index }, i) => {
        const first = reportsPerKill[i][0];
        if (!first) return;
        rows.push({
          encounterId: kill.encounterId,
          bossIndex: index,
          bossName: zone.encounters[index].name,
          who: c.name,
          kind: 'kill',
          date: dates?.get(kill.encounterId),
          reportCode: first.reportCode,
          isApplicantCharacter: applicantNames.has(c.name.toLowerCase()),
        });
      });
      return rows;
    });

    const list = evidenceByZone.get(zone.id) ?? [];
    for (const rows of perCharacter) list.push(...rows);
    if (list.length > 0) evidenceByZone.set(zone.id, list);

    if ((evidenceByZone.get(zone.id)?.length ?? 0) > 0) producedZones++;
  }

  // One wipe line per tier: the boss immediately after the deepest kill.
  //
  // Zones run concurrently (they are wholly independent — each appends only to
  // its own evidence array) and, within a character, the up-to-8 report scans do
  // too. Serially this was the last untouched hot path in the phase: 5 zones x up
  // to 8 sequential getReportWipes, and the measured job spent 54.9s in `gather`.
  //
  // The selection is deliberately unchanged: still the FIRST character in `swept`
  // order to yield a wipe, and within that character the first report in
  // newest-first order that contains one. Only the fetching overlaps, so the
  // published line is identical to the serial version's.
  //
  // The one real cost: a character's 8 report scans are now all issued, where
  // the serial loop stopped at the first match. WCL bills by points, so that is
  // extra spend in the lucky case (bounded at 8 per character per tier, which
  // the serial worst case already paid) and the 90% points pre-emption still
  // guards the budget.
  await mapLimit(
    [...evidenceByZone.entries()],
    WIPE_ZONE_CONCURRENCY,
    async ([zoneId, evidence]) => {
      const zone = zoneById.get(zoneId)!;
      const deepest = Math.max(...evidence.map((e) => e.bossIndex));
      const target = zone.encounters[deepest + 1];
      if (!target) return;

      let found: BossEvidence | null = null;
      // Characters stay SERIAL: the first one with a wipe wins, so running them
      // concurrently would buy latency by paying for scans of characters the
      // serial version never touched.
      for (const c of swept) {
        if (found) break;
        const reports = (await deps.getRaidReports(c, new Set([zoneId])))
          .sort((a, b) => b.startTime - a.startTime)
          .slice(0, WIPE_SCAN_REPORTS);
        const wipesPerReport = await mapLimit(reports, WCL_CONCURRENCY, (report) =>
          deps.getReportWipes(report.code),
        );
        // mapLimit preserves input order, so this walks the reports newest-first
        // exactly as the serial loop did.
        for (let i = 0; i < reports.length; i++) {
          const wipes = wipesPerReport[i]
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
            reportCode: reports[i].code,
            isApplicantCharacter: applicantNames.has(who.toLowerCase()),
          };
          break;
        }
      }
      if (found) evidence.push(found);
    },
  );

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

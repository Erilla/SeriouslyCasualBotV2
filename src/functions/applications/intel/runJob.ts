import { logger } from '../../../services/logger.js';
import { backoffMs, classifyError } from './rateLimit.js';
import {
  getApplicantCharacters,
  getFindings,
  getJob,
  pauseJob,
  scannedCount,
  setGuildHistory,
  setPhase,
  setStatus,
  type IntelFinding,
} from './jobStore.js';
import {
  renderFooter,
  renderFoundCharacters,
  renderGuildHistory,
  renderMythicLogs,
  type GuildHistoryEntry,
  type PauseFooter,
} from './render.js';
import { discoverAlts, ALT_CAPS } from '../alts/discoverAlts.js';
import { confirmDiscord } from '../alts/confirmDiscord.js';
import { aggregateGuildHistory, gatherMythicLogs } from '../mythic-logs/gatherMythicLogs.js';
import {
  selectSweepTargets,
  characterKey,
  type SweepCandidate,
} from '../mythic-logs/selectMythicReports.js';
import type { WclZone } from '../mythic-logs/zoneCatalogue.js';
import { WclPointsExhausted, type RaidReportRef } from '../../../services/warcraftlogs.js';
import type { MythicKillDate } from '../../../services/raiderioInternal.js';
import type { RaiderIoCharacter } from '../raiderIoName.js';

export const MAX_JOB_ATTEMPTS = 20;
export const MAX_JOB_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Alts given a full log sweep, on top of every application-named character. */
export const ALT_SWEEP_SLOTS = 4;

export interface RunDeps {
  editMessage: (channelId: string, messageId: string, description: string) => Promise<void>;
  discover: typeof discoverAlts;
  gather: typeof gatherMythicLogs;
  confirm: typeof confirmDiscord;
  getZoneCatalogue: () => Promise<WclZone[]>;
  getMythicKillCount: (c: RaiderIoCharacter) => Promise<number>;
  getRaidReports: (c: RaiderIoCharacter, zoneIds: Set<number>) => Promise<RaidReportRef[]>;
  // The guild-history loop's own dependency, distinct from the copies passed
  // into DiscoverDeps/GatherDeps: unlike those (which are only ever read as
  // object-literal properties by mocked discover/gather in tests, never
  // actually called), runJob calls this one directly itself — so without
  // injection here a unit test hits the real raiderioInternal module and its
  // live network + 700ms pace.
  getMythicKillDates: (
    c: RaiderIoCharacter,
    tierOrdinals: number[],
  ) => Promise<MythicKillDate[] | null>;
  paceMs?: number;
  tierOrdinals: number[];
  now?: () => Date;
}

function findingToCharacter(f: IntelFinding, region: string): RaiderIoCharacter {
  return { region, realm: f.realm, name: f.name };
}

/**
 * SQLite's `datetime('now')` writes UTC with no zone marker
 * (`"YYYY-MM-DD HH:MM:SS"`), which `new Date(...)` parses as LOCAL time —
 * silently shifting the 7-day abandonment boundary by the host's UTC offset.
 * Force the UTC interpretation explicitly.
 */
export function parseUtcTimestamp(value: string): Date {
  return new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
}

// Placeholders matching what the message-creation step writes, so a phase
// that never ran shows the same honest "still working" copy it started
// with rather than a data-driven renderer's "nothing found" — which would
// misreport a phase that was never measured as a measured absence.
const GUILDS_PLACEHOLDER = '**Guild history** — searching…';
const LOGS_PLACEHOLDER = '**Mythic raid logs** — fetching…';
/** Appended to a placeholder on a terminal outcome with no rate-limit
 *  footer of its own (e.g. a generic degrade-and-finish), so the message
 *  never reads as "still searching" once nothing will ever retry it. */
const UNRUN_TERMINAL_NOTE = '*Incomplete — this part did not complete this run.*';

/**
 * The body for a message whose phase never ran. Never calls a data-driven
 * renderer (renderGuildHistory/renderMythicLogs) here — that is exactly
 * what would produce a false "nothing found" for data that was never
 * queried. A footer (pause or abandonment) is appended whenever present, so
 * the rate-limit signal stays visible on every message; on a terminal
 * outcome with no footer, a short factual note takes its place instead of
 * leaving the placeholder to read as still in progress.
 */
function unrunBody(
  placeholder: string,
  footer: PauseFooter | undefined,
  terminal: boolean,
): string {
  if (footer) return `${placeholder}\n\n${renderFooter(footer)}`;
  if (terminal) return `${placeholder}\n\n${UNRUN_TERMINAL_NOTE}`;
  return placeholder;
}

/**
 * Run one applicant-intel job to completion, a pause, or abandonment.
 *
 * Only rate limiting pauses; any other failure degrades that phase and the job
 * still publishes what it has, because an application must never be left with a
 * placeholder reading "searching…".
 */
export async function runJob(jobId: number, deps: RunDeps): Promise<void> {
  const job = getJob(jobId);
  if (!job || !job.target_channel_id) return;

  const now = deps.now ?? (() => new Date());
  const primary: RaiderIoCharacter = {
    region: job.character_region,
    realm: job.character_realm,
    name: job.character_name,
  };
  // An application — or /test — can name several characters; the row holds only
  // the primary, so the full set comes from the queue.
  const stored = getApplicantCharacters(jobId);
  const applicants = stored.length > 0 ? stored : [primary];
  const applicant = applicants[0];

  setStatus(jobId, 'running');

  // `terminal` marks an outcome nothing will ever retry (degrade-to-`done`
  // or abandonment): every message is always published on such an outcome,
  // and an un-run phase gets a factual "did not complete" note rather than
  // being left on its placeholder forever, since nothing revisits a done job.
  const publish = async (footer?: PauseFooter, terminal = false): Promise<void> => {
    const findings = getFindings(jobId);
    const channelId = job.target_channel_id!;

    if (job.alts_message_id) {
      try {
        const pages = renderFoundCharacters(findings, applicant.name, applicant.region, footer);
        await deps.editMessage(channelId, job.alts_message_id, pages[0]);
      } catch (error) {
        // One rejected edit (e.g. the placeholder was deleted) must not
        // block the other two messages, and must not escape runJob — that
        // would leave a "done" job with the remaining placeholders stuck on
        // "searching…" forever, since nothing retries a done job.
        logger.warn('Intel', `Job #${jobId}: failed to edit the alts message: ${error}`);
      }
    }
    if (job.guilds_message_id) {
      try {
        const body = guildsComputed
          ? renderGuildHistory(guilds, applicant.region, footer)[0]
          : unrunBody(GUILDS_PLACEHOLDER, footer, terminal);
        await deps.editMessage(channelId, job.guilds_message_id, body);
      } catch (error) {
        logger.warn('Intel', `Job #${jobId}: failed to edit the guilds message: ${error}`);
      }
    }
    if (job.logs_message_id) {
      try {
        const body = logsComputed
          ? renderMythicLogs(applicant.name, lastTiers, Math.max(0, sweptCount - 1), footer)
          : unrunBody(LOGS_PLACEHOLDER, footer, terminal);
        await deps.editMessage(channelId, job.logs_message_id, body);
      } catch (error) {
        logger.warn('Intel', `Job #${jobId}: failed to edit the logs message: ${error}`);
      }
    }
  };

  let lastTiers: Awaited<ReturnType<typeof gatherMythicLogs>> = [];
  let guilds: GuildHistoryEntry[] = [];
  let sweptCount = 0;
  let guildsComputed = false;
  let logsComputed = false;
  // job.phase is a snapshot from before this run started; setPhase writes
  // the DB but not this object, so the failure log below must track the
  // phase that actually ran itself rather than reading job.phase (which
  // defaults to 'logs' — the one phase that certainly didn't run if an
  // early phase like discover fails first).
  let currentPhase: string = job.phase;

  try {
    // Phase: alt sources + fingerprint sweep.
    setPhase(jobId, 'alt_sources');
    currentPhase = 'alt_sources';
    const { truncated } = await deps.discover(jobId, applicants, {
      getCharacterOwner: (await import('../../../services/raiderioInternal.js')).getCharacterOwner,
      getClaimedCharacters: (await import('../../../services/raiderioInternal.js'))
        .getClaimedCharacters,
      getCharacterSummary: (await import('../../../services/raiderio.js')).getCharacterSummary,
      getCharacterGuild: (await import('../../../services/raiderio.js')).getCharacterGuild,
      // Blizzard, not getGuildRoster: the latter is hardcoded to our own guild
      // and filters to ROSTER_RANKS, which would silently drop members of a
      // stranger's guild. See Task 8.
      getGuildRoster: async (guild) => {
        // Blizzard, not Raider.IO: it returns roughly twice the members (624 vs
        // 312 on one guild, 688 vs 420 on another) because Raider.IO only knows
        // characters it has crawled. The sweep is roster-driven, so this doubles
        // its reach for one extra request per guild. The GUILD's own realm is
        // used here, never the character's.
        const { getBlizzardGuildRoster } = await import('../../../services/blizzard.js');
        return getBlizzardGuildRoster(applicant.region, guild.realm, guild.name);
      },
      getCharacterFingerprint: (await import('../../../services/blizzard.js'))
        .getCharacterFingerprint,
      getMythicKillDates: (await import('../../../services/raiderioInternal.js'))
        .getMythicKillDates,
      tierOrdinals: deps.tierOrdinals,
      paceMs: (await import('../../../services/raiderioInternal.js')).RAIDERIO_INTERNAL_PACE_MS,
    });
    if (truncated) {
      logger.warn('Intel', `Job #${jobId}: alt sweep truncated by caps`);
    }

    // Discord confirmation: runs right after discovery and before the log
    // sweep, so the found-characters message carries verdicts the first
    // time it is edited (at the end of this function, or on a pause/failure
    // in a later phase).
    const discord = await deps.confirm(jobId, applicant.region, job.applicant_discord, {
      getCharacterOwner: (await import('../../../services/raiderioInternal.js')).getCharacterOwner,
      paceMs: (await import('../../../services/raiderioInternal.js')).RAIDERIO_INTERNAL_PACE_MS,
    });
    if (discord.confirmed > 0 || discord.mismatched > 0) {
      logger.info(
        'Intel',
        `Job #${jobId}: ${discord.confirmed} Discord-confirmed, ${discord.mismatched} mismatched`,
      );
    }

    // Phase: which characters deserve a log sweep, then the sweep itself.
    setPhase(jobId, 'alt_logs');
    currentPhase = 'alt_logs';
    const zones = await deps.getZoneCatalogue();
    const zoneIds = new Set(zones.map((z) => z.id));
    const findings = getFindings(jobId);

    const candidates: SweepCandidate[] = [];
    for (const f of findings) {
      if (f.source === 'application') continue;
      const c = findingToCharacter(f, applicant.region);
      const reports = await deps.getRaidReports(c, zoneIds);
      candidates.push({
        name: f.name,
        realm: f.realm,
        mythicKills: await deps.getMythicKillCount(c),
        tiers: [...new Set(reports.map((r) => r.zoneId))],
      });
    }

    const applicantKeys = findings
      .filter((f) => f.source === 'application')
      .map((f) => characterKey(f.name, f.realm));
    const chosen = new Set(selectSweepTargets(applicantKeys, candidates, ALT_SWEEP_SLOTS));
    const swept = findings
      .filter((f) => chosen.has(characterKey(f.name, f.realm)))
      .map((f) => findingToCharacter(f, applicant.region));
    sweptCount = swept.length;

    // Guild history rides along with the kill dates the log sweep needs
    // anyway. Uses deps.getMythicKillDates/deps.paceMs directly (not an
    // inline import of the real module): runJob calls this itself rather
    // than merely passing it through to a mocked discover/gather, so an
    // uninjected real import here would hit the network in every test.
    const killHistory: { character: string; entries: MythicKillDate[] }[] = [];
    for (const c of swept.length > 0 ? swept : applicants) {
      const entries = await deps.getMythicKillDates(c, deps.tierOrdinals);
      await new Promise((r) => setTimeout(r, deps.paceMs ?? 0));
      if (entries) killHistory.push({ character: c.name, entries });
    }
    guilds = aggregateGuildHistory(killHistory, zones);
    guildsComputed = true;
    // Persist BEFORE publishing: a pause between the two must still leave the
    // data retrievable, since durable pagination for this embed rebuilds
    // from the database rather than from memory that is thrown away at the
    // end of this function. Uses setGuildHistory (an upsert), not enqueue
    // (ON CONFLICT DO NOTHING) — a resumed job must overwrite a prior
    // attempt's history rather than being stuck with the first one forever.
    setGuildHistory(jobId, guilds);

    setPhase(jobId, 'logs');
    currentPhase = 'logs';
    lastTiers = await deps.gather(applicants, swept.length > 0 ? swept : applicants, zones, {
      getZoneKills: (await import('../../../services/warcraftlogs.js')).getZoneKills,
      getEncounterKills: (await import('../../../services/warcraftlogs.js')).getEncounterKills,
      getRaidReports: deps.getRaidReports,
      getReportWipes: (await import('../../../services/warcraftlogs.js')).getReportWipes,
      getMythicKillDates: (await import('../../../services/raiderioInternal.js'))
        .getMythicKillDates,
      tierOrdinals: deps.tierOrdinals,
      paceMs: (await import('../../../services/raiderioInternal.js')).RAIDERIO_INTERNAL_PACE_MS,
    });
    logsComputed = true;

    setPhase(jobId, 'done');
    currentPhase = 'done';
    setStatus(jobId, 'done');
    await publish();
  } catch (error) {
    // WarcraftLogs bills by points, so a WclPointsExhausted is thrown to
    // PRE-EMPT a 429 at 90% of the hourly budget. classifyError only pauses
    // on CircuitOpenError or a 429 HttpError, so without this branch it would
    // fall into the !pause path below and permanently truncate the logs —
    // defeating the whole point of pre-empting. An hour is the natural
    // backoff ceiling here because the WCL points budget resets hourly.
    if (error instanceof WclPointsExhausted) {
      const age = now().getTime() - parseUtcTimestamp(job.created_at).getTime();
      const exhausted = job.attempts + 1 >= MAX_JOB_ATTEMPTS || age >= MAX_JOB_AGE_MS;
      const service = 'warcraftlogs';

      if (exhausted) {
        setStatus(jobId, 'failed');
        await publish(
          {
            service,
            scanned: scannedCount(jobId),
            total: ALT_CAPS.characters,
            abandoned: true,
          },
          true,
        );
        logger.warn('Intel', `Job #${jobId} abandoned after ${job.attempts + 1} attempts`);
        return;
      }

      pauseJob(jobId, service, backoffMs(job.attempts + 1));
      const paused = getJob(jobId);
      await publish({
        service,
        scanned: scannedCount(jobId),
        total: ALT_CAPS.characters,
        retryAt: paused?.resume_after ? new Date(paused.resume_after) : undefined,
      });
      logger.info('Intel', `Job #${jobId} paused on ${service}; resuming ${paused?.resume_after}`);
      return;
    }

    const decision = classifyError(error, job.attempts + 1);
    const age = now().getTime() - parseUtcTimestamp(job.created_at).getTime();
    const exhausted = job.attempts + 1 >= MAX_JOB_ATTEMPTS || age >= MAX_JOB_AGE_MS;

    if (!decision.pause) {
      logger.warn('Intel', `Job #${jobId} failed in phase ${currentPhase}: ${error}`);
      setStatus(jobId, 'done');
      await publish(undefined, true);
      return;
    }

    const service = decision.service ?? 'unknown';
    if (exhausted) {
      setStatus(jobId, 'failed');
      await publish(
        {
          service,
          scanned: scannedCount(jobId),
          total: ALT_CAPS.characters,
          abandoned: true,
        },
        true,
      );
      logger.warn('Intel', `Job #${jobId} abandoned after ${job.attempts + 1} attempts`);
      return;
    }

    pauseJob(jobId, service, decision.resumeAfterMs ?? 0);
    const paused = getJob(jobId);
    await publish({
      service,
      scanned: scannedCount(jobId),
      total: ALT_CAPS.characters,
      retryAt: paused?.resume_after ? new Date(paused.resume_after) : undefined,
    });
    logger.info('Intel', `Job #${jobId} paused on ${service}; resuming ${paused?.resume_after}`);
  }
}

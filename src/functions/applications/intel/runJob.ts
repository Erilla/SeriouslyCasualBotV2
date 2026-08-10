import { logger } from '../../../services/logger.js';
import { backoffMs, classifyError } from './rateLimit.js';
import {
  consumeTopUpRequest,
  getAnchorFingerprint,
  getApplicantCharacters,
  getFindings,
  getJob,
  getLinkedCharacters,
  getTopUpState,
  isSelfDeclared,
  needsDiscordConfirmation,
  pauseJob,
  scannedCount,
  setAnchorFingerprint,
  setGuildHistory,
  setSweepCandidates,
  getSweepCandidates,
  setPhase,
  setSweepTruncated,
  setStatus,
  topUpRequested,
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
import { mapLimit } from '../../../utils/concurrency.js';
import { PhaseTimings } from './phaseTimings.js';
import type { WclZone } from '../mythic-logs/zoneCatalogue.js';
import { WclPointsExhausted, type RaidReportRef } from '../../../services/warcraftlogs.js';
import type { MythicKillDate } from '../../../services/raiderioInternal.js';
import type { RaiderIoCharacter } from '../characterLinks.js';

export const MAX_JOB_ATTEMPTS = 20;
export const MAX_JOB_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Alts given a full log sweep, on top of every application-named character. */
export const ALT_SWEEP_SLOTS = 4;

/**
 * Concurrent candidate lookups. Each is an independent getRaidReports (paginated
 * WarcraftLogs) plus a getMythicKillCount, and serially this measured ~50s across
 * 24 findings. WCL bills by points rather than requests, so this raises only the
 * burst rate.
 */
const CANDIDATE_CONCURRENCY = 6;

/** Pace between Raider.IO-internal calls, owned by the kill-dates memo below. */
const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();

/**
 * Paging metadata handed to `editMessage` so the durable `intelpage:` /
 * `intelguildpage:` buttons and the `Page x/y` footer can be attached to a
 * published message. runJob must stay free of discord.js, so it describes the
 * paging rather than building the components itself; the injected editMessage
 * (the legitimately Discord-bound half) turns this into an actual button row.
 *
 * Without it the renderers return N pages, page 1 is published, and pages 2..N
 * are unreachable with no marker that they exist — worse than truncation.
 */
export interface PagingMeta {
  /** Button-handler prefix: `intelpage` or `intelguildpage`. */
  prefix: string;
  jobId: number;
  page: number;
  totalPages: number;
}

export interface RunDeps {
  editMessage: (
    channelId: string,
    messageId: string,
    description: string,
    paging?: PagingMeta,
  ) => Promise<void>;
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

function identityKey(character: RaiderIoCharacter): string {
  return [character.region, character.realm, character.name]
    .map((part) => part.trim().normalize('NFC').toLowerCase())
    .join('/');
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
 * Appended to the found-characters body when `discoverAlts` reports
 * `truncated`. That flag covers both a genuine cap hit and the case where the
 * applicant's own fingerprint was unavailable, so NOT ONE comparison happened —
 * and without a note a reviewer reads a zero-comparison sweep as "this
 * applicant has no alts". Deliberately worded so it is not mistaken for the
 * rate-limit footer, which may appear alongside it.
 */
export const TRUNCATED_NOTE =
  '*Search incomplete — not every candidate character could be checked, so undeclared characters may be missing.*';

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

  // Clear the request that caused this run before any await. A link appended
  // while the run is active then remains requested and schedules a replay.
  const consumedTopUp = consumeTopUpRequest(jobId);
  const topUpState = getTopUpState(jobId);
  // The request bit is a wakeup, not the lifetime marker. It is cleared at the
  // first attempt so mid-run appends remain visible, while the durable state row
  // keeps every rate-limit resume in top-up rendering mode.
  const topUpRun = consumedTopUp || topUpState !== null;
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
  const linked = getLinkedCharacters(jobId);
  const reopenedAt = topUpState?.reopenedAt;
  const ageEpochMs = Math.max(
    parseUtcTimestamp(job.created_at).getTime(),
    reopenedAt ? parseUtcTimestamp(reopenedAt).getTime() : Number.NEGATIVE_INFINITY,
  );

  setStatus(jobId, 'running');
  const timings = new PhaseTimings();

  // `terminal` marks an outcome nothing will ever retry (degrade-to-`done`
  // or abandonment): every message is always published on such an outcome,
  // and an un-run phase gets a factual "did not complete" note rather than
  // being left on its placeholder forever, since nothing revisits a done job.
  const publish = async (footer?: PauseFooter, terminal = false): Promise<void> => {
    const findings = getFindings(jobId);
    const channelId = job.target_channel_id!;
    // A linked character can be appended after the run starts. Re-read the
    // durable request here so that this publish does not overwrite phases the
    // current run has not recomputed, even when it began as a normal run.
    const protectExistingMessages = topUpRun || topUpRequested(jobId);

    if (job.alts_message_id) {
      try {
        const pages = renderFoundCharacters(findings, applicant.name, applicant.region, footer);
        const body = sweepTruncated ? `${pages[0]}\n\n${TRUNCATED_NOTE}` : pages[0];
        await deps.editMessage(channelId, job.alts_message_id, body, {
          prefix: 'intelpage',
          jobId,
          page: 1,
          totalPages: pages.length,
        });
      } catch (error) {
        // One rejected edit (e.g. the placeholder was deleted) must not
        // block the other two messages, and must not escape runJob — that
        // would leave a "done" job with the remaining placeholders stuck on
        // "searching…" forever, since nothing retries a done job.
        logger.warn('Intel', `Job #${jobId}: failed to edit the alts message: ${error}`);
      }
    }
    if (job.guilds_message_id && (!protectExistingMessages || guildsComputed)) {
      try {
        const pages = guildsComputed
          ? renderGuildHistory(guilds, applicant.region, footer)
          : [unrunBody(GUILDS_PLACEHOLDER, footer, terminal)];
        await deps.editMessage(channelId, job.guilds_message_id, pages[0], {
          prefix: 'intelguildpage',
          jobId,
          page: 1,
          totalPages: pages.length,
        });
      } catch (error) {
        logger.warn('Intel', `Job #${jobId}: failed to edit the guilds message: ${error}`);
      }
    }
    if (job.logs_message_id && (!protectExistingMessages || logsComputed)) {
      try {
        // Never paged: bounded at MAX_TIERS=5 x MAX_LINES_PER_TIER=3.
        const body = logsComputed
          ? renderMythicLogs(applicant.name, lastTiers, Math.max(0, sweptCount - 1), footer)
          : unrunBody(LOGS_PLACEHOLDER, footer, terminal);
        await deps.editMessage(channelId, job.logs_message_id, body);
      } catch (error) {
        logger.warn('Intel', `Job #${jobId}: failed to edit the logs message: ${error}`);
      }
    }
  };

  const requeueRequestedTopUp = (): boolean => {
    if (!topUpRequested(jobId)) return false;
    setStatus(jobId, 'pending');
    return true;
  };

  let lastTiers: Awaited<ReturnType<typeof gatherMythicLogs>> = [];
  let guilds: GuildHistoryEntry[] = [];
  let sweptCount = 0;
  let guildsComputed = false;
  let logsComputed = false;
  // Read by `publish` (declared above it, assigned after `discover` returns) to
  // tell the reader that the sweep left work undone.
  let sweepTruncated = false;
  // job.phase is a snapshot from before this run started; setPhase writes
  // the DB but not this object, so the failure log below must track the
  // phase that actually ran itself rather than reading job.phase (which
  // defaults to 'logs' — the one phase that certainly didn't run if an
  // early phase like discover fails first).
  let currentPhase: string = job.phase;

  /**
   * One Raider.IO kill-history fetch per character per job.
   *
   * Three separate places wanted the same payload: the sweep walks it for FORMER
   * guilds, the guild-history phase aggregates it, and gatherMythicLogs matches
   * first-kill dates onto WCL encounters. Nothing cached it at any level, so each
   * swept character was fetched up to three times from an endpoint measured at
   * 1,029ms — and paid the 700ms pace each time.
   *
   * In-memory and per job, deliberately: it is discarded when the job ends. The
   * data is worth nothing later (an applicant does not reapply) but a great deal
   * forty seconds later, in the same run.
   *
   * The PACE lives here rather than at the call sites, which is also the correct
   * home for it: it exists to space out REQUESTS, and the callers each slept
   * unconditionally after asking — so a cache hit used to sleep 700ms having made
   * no request at all.
   */
  const killDatesByCharacter = new Map<string, Promise<MythicKillDate[] | null>>();
  const getMythicKillDatesOnce = async (
    c: RaiderIoCharacter,
    tierOrdinals: number[],
  ): Promise<MythicKillDate[] | null> => {
    // Keyed on the tiers too: a caller asking for a different set must not be
    // served another's answer.
    const ck = `${characterKey(c.name, c.realm)}:${tierOrdinals.join(',')}`;
    let pending = killDatesByCharacter.get(ck);
    if (!pending) {
      pending = (async () => {
        const entries = await deps.getMythicKillDates(c, tierOrdinals);
        await sleep(deps.paceMs ?? 0);
        return entries;
      })();
      killDatesByCharacter.set(ck, pending);
    }
    try {
      return await pending;
    } catch (error) {
      // getMythicKillDates reports failure as null rather than throwing, so this
      // is belt-and-braces: never leave a rejection in the memo, or every later
      // caller in the run fails instantly on a stale error instead of retrying.
      killDatesByCharacter.delete(ck);
      throw error;
    }
  };

  try {
    // Phase: alt sources + fingerprint sweep.
    setPhase(jobId, 'alt_sources');
    currentPhase = 'alt_sources';
    const blizzard = await import('../../../services/blizzard.js');
    const storedAnchor = getAnchorFingerprint(jobId);
    const primaryIdentity = identityKey(applicant);
    const reusableAnchor =
      storedAnchor && identityKey(storedAnchor) === primaryIdentity ? storedAnchor : null;
    let anchor = reusableAnchor ? new Map(reusableAnchor.entries) : null;
    const getAnchorFingerprintForRun = async (character: RaiderIoCharacter) => {
      if (anchor) return anchor;

      const fetched = await blizzard.getCharacterFingerprint(character);
      if (fetched) {
        anchor = fetched;
        setAnchorFingerprint(jobId, {
          ...applicant,
          entries: [...fetched.entries()],
          fetchedAt: now().toISOString(),
        });
      }
      return fetched;
    };

    const { truncated } = await deps.discover(jobId, applicants, linked, {
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
      getAnchorFingerprint: getAnchorFingerprintForRun,
      getCharacterFingerprint: blizzard.getCharacterFingerprint,
      // The shared memo, not the raw module function: the sweep's former-guild
      // walk asks for every KNOWN character, which the guild-history and log
      // phases then ask for again. It paces itself, so the sweep no longer
      // sleeps after this particular call.
      getMythicKillDates: getMythicKillDatesOnce,
      tierOrdinals: deps.tierOrdinals,
      paceMs: (await import('../../../services/raiderioInternal.js')).RAIDERIO_INTERNAL_PACE_MS,
      timings,
    });
    // Surfaced to the READER, not just the log: `truncated` also covers "the
    // applicant's own fingerprint was unavailable, so no comparison happened at
    // all", which a bare "Found characters — 1" misreports as a measured
    // absence. See TRUNCATED_NOTE.
    sweepTruncated = truncated;
    // Persisted as well as rendered: the found-characters embed is paged, and
    // paging back to page 1 rebuilds it from the database, where a note that
    // only lived in the published message would be lost.
    setSweepTruncated(jobId, truncated);
    timings.mark('discover');
    if (truncated) {
      logger.warn('Intel', `Job #${jobId}: alt sweep truncated by caps`);
    }

    // Discord confirmation: runs right after discovery and before the log
    // sweep, so the found-characters message carries verdicts the first
    // time it is edited (at the end of this function, or on a pause/failure
    // in a later phase).
    // Candidates the pass will actually try: it skips 'application' findings
    // (nothing to confirm). No longer gated on a declared handle — the pass also
    // reads each character's declared main, which needs no Discord handle.
    const confirmable = getFindings(jobId).filter((f) => needsDiscordConfirmation(f.source)).length;
    const discord = await deps.confirm(jobId, applicant.region, job.applicant_discord, {
      getCharacterOwner: (await import('../../../services/raiderioInternal.js')).getCharacterOwner,
      paceMs: (await import('../../../services/raiderioInternal.js')).RAIDERIO_INTERNAL_PACE_MS,
    });
    // Logged UNCONDITIONALLY, with the number attempted: gated on
    // `confirmed > 0 || mismatched > 0` a total confirmation-API failure was
    // indistinguishable from "no handles were exposed".
    logger.info(
      'Intel',
      `Job #${jobId}: owner lookup attempted on ${confirmable} character(s) — ` +
        `${discord.confirmed} Discord-confirmed, ${discord.mismatched} mismatched, ` +
        `${discord.backLinked} declaring an applicant character as their main`,
    );

    // Phase: which characters deserve a log sweep, then the sweep itself.
    timings.mark('confirm');

    setPhase(jobId, 'alt_logs');
    currentPhase = 'alt_logs';
    const zones = await deps.getZoneCatalogue();
    const zoneIds = new Set(zones.map((z) => z.id));
    const findings = getFindings(jobId);

    // One recentReports walk per character per run. getRaidReports paginates
    // WarcraftLogs and filters by zone client-side, so the candidate enumeration
    // below and gatherMythicLogs' wipe scan were each paying for the same walk;
    // fetch the full zone set once and filter locally for both.
    //
    // Memoises the PROMISE, not the resolved value: gatherMythicLogs' wipe scan
    // now runs its zones concurrently, so several zones ask for the same
    // character's reports at once. Caching only the settled value leaves a
    // window where every concurrent caller misses and pays for its own
    // paginated walk — the exact duplication this memo exists to prevent.
    const reportsByCharacter = new Map<string, Promise<RaidReportRef[]>>();
    const getRaidReportsOnce = async (
      c: RaiderIoCharacter,
      wanted: Set<number>,
    ): Promise<RaidReportRef[]> => {
      const ck = characterKey(c.name, c.realm);
      let pending = reportsByCharacter.get(ck);
      if (!pending) {
        pending = deps.getRaidReports(c, zoneIds);
        reportsByCharacter.set(ck, pending);
      }
      let all: RaidReportRef[];
      try {
        all = await pending;
      } catch (error) {
        // Do not cache a rejection: a paused-and-resumed rate limit would
        // otherwise make every later caller in this run fail instantly on the
        // same stale error instead of retrying.
        reportsByCharacter.delete(ck);
        throw error;
      }
      return all.filter((r) => wanted.has(r.zoneId));
    };

    // Enumerated incrementally and persisted: this is the single most expensive
    // thing a resumed attempt used to repeat. Each character costs a paginated
    // getRaidReports plus a getMythicKillCount, so 24 findings meant ~100 WCL
    // queries before any new work — and WCL bills by points, so a job could
    // re-exhaust its budget on re-enumeration and abandon without progressing.
    // Keyed by character, so one discovered on a later attempt is still done once.
    const byCandidate = new Map<string, SweepCandidate>(
      getSweepCandidates<SweepCandidate>(jobId).map((c) => [characterKey(c.name, c.realm), c]),
    );
    // Enumerated concurrently: each character is an independent pair of lookups,
    // and serially this was ~50s on 24 findings. mapLimit preserves input order,
    // so the persisted list is deterministic regardless of completion order.
    const toEnumerate = findings.filter(
      (f) => !isSelfDeclared(f.source) && !byCandidate.has(characterKey(f.name, f.realm)),
    );
    const freshCandidates = await mapLimit(toEnumerate, CANDIDATE_CONCURRENCY, async (f) => {
      const c = findingToCharacter(f, applicant.region);
      const [reports, mythicKills] = await Promise.all([
        getRaidReportsOnce(c, zoneIds),
        deps.getMythicKillCount(c),
      ]);
      return {
        name: f.name,
        realm: f.realm,
        mythicKills,
        tiers: [...new Set(reports.map((r) => r.zoneId))],
      };
    });
    for (const cand of freshCandidates) byCandidate.set(characterKey(cand.name, cand.realm), cand);
    const candidates = [...byCandidate.values()];
    if (freshCandidates.length > 0) setSweepCandidates(jobId, candidates);
    timings.mark('candidates');

    const applicantKeys = findings
      .filter((f) => isSelfDeclared(f.source))
      .map((f) => characterKey(f.name, f.realm));
    const chosen = new Set(selectSweepTargets(applicantKeys, candidates, ALT_SWEEP_SLOTS));
    const swept = findings
      .filter((f) => chosen.has(characterKey(f.name, f.realm)))
      .map((f) => findingToCharacter(f, applicant.region));
    sweptCount = swept.length;

    // Guild history rides along with the kill dates the log sweep needs
    // anyway — and, via getMythicKillDatesOnce, off the same fetch: for a
    // character the sweep already walked for former guilds this loop now costs
    // nothing at all. Goes through the memo (which wraps the injected
    // deps.getMythicKillDates) rather than an inline import of the real module:
    // runJob calls this itself rather than merely passing it through to a
    // mocked discover/gather, so an uninjected real import here would hit the
    // network in every test.
    const killHistory: { character: string; entries: MythicKillDate[] }[] = [];
    // getMythicKillDates swallows EVERYTHING (including a 429) and reports
    // failure only as `null`, so a total Raider.IO-internal outage otherwise
    // aggregates to `[]` — indistinguishable from a genuinely kill-less
    // account. For a solo applicant with one swept character that is a single
    // failed fetch away, so it must be tracked, not assumed away.
    let killDatesFailed = false;
    for (const c of swept.length > 0 ? swept : applicants) {
      // The memo paces itself, so there is no sleep here any more.
      const entries = await getMythicKillDatesOnce(c, deps.tierOrdinals);
      if (entries) killHistory.push({ character: c.name, entries });
      else killDatesFailed = true;
    }
    guilds = aggregateGuildHistory(killHistory, zones);
    timings.mark('guildHistory');

    if (guilds.length === 0 && killDatesFailed) {
      // An UNMEASURED absence. Leave guildsComputed false so `publish` takes the
      // placeholder path instead of publishing the affirmative "No guild history
      // found — no Mythic kills recorded with any guild", and skip the
      // setGuildHistory write entirely so a previously-good stored history is
      // never overwritten by this (which would also make the paginated copy
      // serve the false page).
      logger.warn(
        'Intel',
        `Job #${jobId}: guild history unmeasured — every kill-date fetch failed; not publishing or storing an empty history`,
      );
    } else {
      guildsComputed = true;
      // Persist BEFORE publishing: a pause between the two must still leave the
      // data retrievable, since durable pagination for this embed rebuilds
      // from the database rather than from memory that is thrown away at the
      // end of this function. Uses setGuildHistory (an upsert), not enqueue
      // (ON CONFLICT DO NOTHING) — a resumed job must overwrite a prior
      // attempt's history rather than being stuck with the first one forever.
      setGuildHistory(jobId, guilds);
    }

    setPhase(jobId, 'logs');
    currentPhase = 'logs';
    lastTiers = await deps.gather(applicants, swept.length > 0 ? swept : applicants, zones, {
      getZoneKills: (await import('../../../services/warcraftlogs.js')).getZoneKills,
      getEncounterKills: (await import('../../../services/warcraftlogs.js')).getEncounterKills,
      getRaidReports: getRaidReportsOnce,
      getReportWipes: (await import('../../../services/warcraftlogs.js')).getReportWipes,
      // Every swept character has already been fetched by the guild-history loop
      // immediately above, so this whole phase of the gather is now free.
      getMythicKillDates: getMythicKillDatesOnce,
      tierOrdinals: deps.tierOrdinals,
    });
    logsComputed = true;

    timings.mark('gather');

    // debug, not info: this exists for optimisation work, and the phases are
    // measured now. Raise it again when the next round needs them.
    logger.debug('Intel', `Job #${jobId} timings: ${timings.summary()}`);
    setPhase(jobId, 'done');
    currentPhase = 'done';
    const replayRequested = topUpRequested(jobId);
    setStatus(jobId, replayRequested ? 'pending' : 'done');
    // Terminal: nothing retries a done job. Normally every phase computed, so
    // the flag is inert — but the guild-history phase can legitimately end
    // unmeasured (all kill-date fetches failed), and that message must then say
    // "Incomplete" rather than sit on "searching…" forever.
    await publish(undefined, !replayRequested);
  } catch (error) {
    // WarcraftLogs bills by points, so a WclPointsExhausted is thrown to
    // PRE-EMPT a 429 at 90% of the hourly budget. classifyError only pauses
    // on CircuitOpenError or a 429 HttpError, so without this branch it would
    // fall into the !pause path below and permanently truncate the logs —
    // defeating the whole point of pre-empting. An hour is the natural
    // backoff ceiling here because the WCL points budget resets hourly.
    if (error instanceof WclPointsExhausted) {
      const age = now().getTime() - ageEpochMs;
      const exhausted = job.attempts + 1 >= MAX_JOB_ATTEMPTS || age >= MAX_JOB_AGE_MS;
      const service = 'warcraftlogs';

      if (exhausted) {
        if (requeueRequestedTopUp()) {
          await publish();
          logger.info('Intel', `Job #${jobId} requeued for linked-character top-up`);
          return;
        }
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

    logger.debug('Intel', `Job #${jobId} timings (incomplete): ${timings.summary()}`);
    const decision = classifyError(error, job.attempts + 1);
    const age = now().getTime() - ageEpochMs;
    const exhausted = job.attempts + 1 >= MAX_JOB_ATTEMPTS || age >= MAX_JOB_AGE_MS;

    if (!decision.pause) {
      logger.warn('Intel', `Job #${jobId} failed in phase ${currentPhase}: ${error}`);
      const replayRequested = topUpRequested(jobId);
      setStatus(jobId, replayRequested ? 'pending' : 'done');
      await publish(undefined, !replayRequested);
      return;
    }

    const service = decision.service ?? 'unknown';
    if (exhausted) {
      if (requeueRequestedTopUp()) {
        await publish();
        logger.info('Intel', `Job #${jobId} requeued for linked-character top-up`);
        return;
      }
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

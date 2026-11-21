import { logger } from '../../../services/logger.js';
import { HttpError } from '../../../services/httpClient.js';
import { raiderIoRealmSlug } from '../../../services/blizzard.js';
import {
  dossierPageUrl,
  SlashWhoContractError,
  type DossierKey,
  type DossierSummary,
  type SlashWhoClient,
} from '../../../services/slashwho.js';
import type { RaiderIoCharacter } from '../characterLinks.js';
import { backoffMs, classifyError } from './rateLimit.js';
import {
  addFinding,
  consumeTopUpRequest,
  fillFindingDetails,
  getApplicantCharacters,
  getFindings,
  getJob,
  getLinkedCharacters,
  getSlashWhoState,
  getTopUpState,
  getUnverifiedLinkedKeys,
  pauseJob,
  setGuildHistory,
  setPhase,
  setSlashWhoState,
  setStatus,
  topUpRequested,
  type FindingSource,
  type SlashWhoJobState,
} from './jobStore.js';
import { raiderIoProfileUrl } from './render.js';
import { MAX_JOB_AGE_MS, MAX_JOB_ATTEMPTS, parseUtcTimestamp, type RunDeps } from './runJob.js';
import {
  characterIdentity,
  mirrorFindings,
  mirrorGuildHistory,
  renderPointer,
  renderSlashWhoSummary,
  type SummaryOutcome,
} from './slashwhoSummary.js';

/** SlashWho's per-create cap; further characters go through add-character. */
export const MAX_CREATE_CHARACTERS = 10;

export interface SlashWhoRunDeps {
  client: SlashWhoClient;
  editMessage: RunDeps['editMessage'];
  /** The Discord confirmation pass, pre-bound to its Raider.IO dependency. */
  confirm: (
    jobId: number,
    region: string,
    applicantDiscord: string | null,
  ) => Promise<{ confirmed: number; mismatched: number; backLinked: number }>;
  /** Base for the officer-facing dossier link. No trailing slash. */
  dossierBaseUrl: string;
  pollIntervalMs: number;
  deadlineMs: number;
  /**
   * The legacy sweep for this job, run instead of publishing "unavailable" when
   * SLASHWHO_FALLBACK_SWEEP is on. Absent means the fallback is off.
   */
  fallback?: (jobId: number) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

const defaultSleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();

/** A failure no retry will fix: publish "unavailable" (or fall back) and stop. */
class TerminalFailure extends Error {
  constructor(
    /** Completes "SlashWho could not research this applicant: …". */
    readonly reason: string,
    readonly source?: unknown,
  ) {
    super(reason);
    this.name = 'TerminalFailure';
  }
}

function characterUrl(c: RaiderIoCharacter): string {
  return raiderIoProfileUrl(c.region, raiderIoRealmSlug(c.realm), c.name);
}

/** Officer-readable copy for a failure; never an HTTP status or a key. */
function terminalReason(error: unknown, root: RaiderIoCharacter): TerminalFailure | null {
  if (error instanceof TerminalFailure) return error;
  if (error instanceof SlashWhoContractError) {
    return new TerminalFailure('its response was not in the expected shape', error);
  }
  if (error instanceof HttpError) {
    if (error.status === 401 || error.status === 403) {
      return new TerminalFailure('the bot is not authorised to use it', error);
    }
    if (error.status === 404) {
      return new TerminalFailure(
        `it has no record of ${root.name} (not on Raider.IO, or removed on request)`,
        error,
      );
    }
    if (error.status === 400) {
      return new TerminalFailure('it rejected the character link', error);
    }
  }
  return null;
}

/**
 * Run one applicant-intel job through a SlashWho dossier.
 *
 * Selected instead of `runJob` when SLASHWHO_INTEL_ENABLED is on. One dossier per
 * application, created once from every declared character; polled until it is
 * ready, partial, or the deadline passes; mirrored into `applicant_intel_*` so
 * trialRealm, #106 and the buttons keep reading the same rows; and published as
 * one compact summary embed with a link to the full dossier.
 *
 * Same contract as runJob for every outcome: rate limits pause and resume, and
 * anything else ends in honest, published copy — never a permanent "searching…".
 */
export async function runSlashWhoJob(jobId: number, deps: SlashWhoRunDeps): Promise<void> {
  const job = getJob(jobId);
  if (!job || !job.target_channel_id) return;
  const channelId = job.target_channel_id;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const started = now().getTime();

  // Cleared before any await, exactly as runJob does: a link appended while
  // this run is active stays requested and either joins this run's poll loop
  // or schedules a replay.
  consumeTopUpRequest(jobId);
  const topUpState = getTopUpState(jobId);

  const primary: RaiderIoCharacter = {
    region: job.character_region,
    realm: job.character_realm,
    name: job.character_name,
  };
  const declared = getApplicantCharacters(jobId);
  // A job rescued by a conversation link has no declared character; the dossier
  // is then rooted on the primary, which is itself a linked character.
  const roster = declared.length > 0 ? declared : [primary];
  const applicant = roster[0];

  setStatus(jobId, 'running');
  setPhase(jobId, 'alt_sources');

  let state: SlashWhoJobState | null = getSlashWhoState(jobId);
  let summary: DossierSummary | null = null;
  let polls = 0;
  const transitions: string[] = [];
  const mirrored: Partial<Record<FindingSource, number>> = {};

  const dossierUrl = (): string | null =>
    state ? dossierPageUrl(deps.dossierBaseUrl, state.root) : null;

  const publish = async (
    outcome: SummaryOutcome,
    extra: { retryAt?: Date; reason?: string } = {},
  ): Promise<void> => {
    const body = renderSlashWhoSummary({
      applicantName: applicant.name,
      region: applicant.region,
      findings: getFindings(jobId),
      unlinkable: getUnverifiedLinkedKeys(jobId),
      summary,
      dossierUrl: dossierUrl(),
      outcome,
      deadlineMs: deps.deadlineMs,
      ...extra,
    });
    // Each edit is isolated: one deleted placeholder must not stop the others,
    // or a finished job would leave the rest reading "searching…" forever.
    const edits: [string | null, string][] = [
      [job.alts_message_id, body],
      [job.guilds_message_id, renderPointer('guilds', outcome, dossierUrl())],
      [job.logs_message_id, renderPointer('logs', outcome, dossierUrl())],
    ];
    for (const [messageId, description] of edits) {
      if (!messageId) continue;
      try {
        // No paging metadata: the compact summary is bounded, so it is never
        // paged, and an edit without paging clears any row a legacy run left.
        await deps.editMessage(channelId, messageId, description);
      } catch (error) {
        logger.warn('Intel', `Job #${jobId}: failed to edit message ${messageId}: ${error}`);
      }
    }
  };

  const logOutcome = (outcome: string): void => {
    const sources = Object.entries(mirrored)
      .map(([source, n]) => `${source}=${n}`)
      .join(', ');
    const root = state ? `${state.root.region}/${state.root.realm}/${state.root.name}` : 'none';
    logger.info(
      'Intel',
      `Job #${jobId} [slashwho] ${outcome}: dossier ${root}, ` +
        `${polls} poll(s) [${transitions.join(' → ') || '-'}], ` +
        `${state?.linkedKeys.length ?? 0} character(s) linked, ` +
        `findings mirrored {${sources || 'none'}}, ${Math.round((now().getTime() - started) / 1000)}s`,
    );
  };

  /** Seed the declared and linked characters, so even "unavailable" lists them. */
  const seedLocalFindings = (): void => {
    for (const c of declared) {
      addFinding(jobId, {
        name: c.name,
        realm: raiderIoRealmSlug(c.realm),
        className: null,
        guildName: null,
        guildRealm: null,
        source: 'application',
        confidence: null,
        discordStatus: null,
        discordProfile: null,
      });
    }
    for (const c of getLinkedCharacters(jobId)) {
      addFinding(jobId, {
        name: c.name,
        realm: raiderIoRealmSlug(c.realm),
        className: null,
        guildName: null,
        guildRealm: null,
        source: 'linked',
        confidence: null,
        discordStatus: null,
        discordProfile: null,
      });
    }
  };

  /** Create the dossier once per job; a resumed or reopened job reuses it. */
  const ensureCreated = async (): Promise<SlashWhoJobState> => {
    if (state) return state;
    const unique = new Map<string, RaiderIoCharacter>();
    for (const c of roster) unique.set(characterIdentity(c), c);
    const all = [...unique.values()];
    const first = all.slice(0, MAX_CREATE_CHARACTERS);
    const result = await deps.client.ensureDossier(first.map(characterUrl));
    const byId = new Map(first.map((c) => [characterIdentity(c), c]));
    const linkedKeys: string[] = [];
    const retry: RaiderIoCharacter[] = all.slice(MAX_CREATE_CHARACTERS);
    for (const o of result.outcomes) {
      const id = characterIdentity(o.key);
      if (o.outcome === 'queued' || o.outcome === 'existing') linkedKeys.push(id);
      // Not linked yet; add-character retries them on the next poll.
      else if (o.outcome === 'rate_limited' || o.outcome === 'failed') {
        const c = byId.get(id);
        if (c) retry.push(c);
      } else {
        logger.info('Intel', `Job #${jobId}: SlashWho skipped ${id} (${o.outcome})`);
        linkedKeys.push(id);
      }
    }
    state = { root: result.root, linkedKeys, retry };
    setSlashWhoState(jobId, state);
    transitions.push(`created:${result.state}`);
    logger.info(
      'Intel',
      `Job #${jobId}: SlashWho dossier created for ${first.length} character(s): ` +
        result.outcomes.map((o) => `${o.key.name}=${o.outcome}`).join(', '),
    );
    return state;
  };

  /**
   * Link anything not yet on the dossier: create outcomes to retry, plus
   * characters pasted into the thread since the last poll. A 429 propagates and
   * pauses the job; the character stays queued for the resume.
   */
  const topUp = async (root: DossierKey): Promise<boolean> => {
    if (!state) return false;
    // Consumed BEFORE the linked characters are read, never after an await: a
    // link pasted while add-character is in flight must leave its request set,
    // so this loop's next pass or finish()'s replay check still sees it.
    consumeTopUpRequest(jobId);
    const current = state;
    const known = new Set(current.linkedKeys);
    const wanted = new Map<string, RaiderIoCharacter>();
    for (const c of current.retry) wanted.set(characterIdentity(c), c);
    for (const c of getLinkedCharacters(jobId)) {
      // A link Raider.IO could not resolve has no URL SlashWho can read.
      if (c.raiderIoVerified === false) continue;
      const id = characterIdentity(c);
      if (!known.has(id)) wanted.set(id, c);
    }
    let added = false;
    for (const [id, c] of wanted) {
      if (known.has(id)) continue;
      try {
        await deps.client.addDossierCharacter(root, characterUrl(c));
        added = true;
      } catch (error) {
        // An unknown or suppressed target, or a URL SlashWho cannot parse: give
        // up on that one character rather than the whole dossier.
        if (error instanceof HttpError && (error.status === 404 || error.status === 400)) {
          logger.info('Intel', `Job #${jobId}: SlashWho could not link ${id} (${error.status})`);
        } else {
          throw error;
        }
      }
      known.add(id);
      state = {
        ...current,
        linkedKeys: [...known],
        retry: current.retry.filter((r) => characterIdentity(r) !== id),
      };
      setSlashWhoState(jobId, state);
    }
    if (added) transitions.push('linked');
    return added;
  };

  /** Mirror the summary into the job's tables, then run the Discord pass. */
  const mirror = async (): Promise<void> => {
    // Again, not just at the start: a link pasted mid-run must be listed even
    // before SlashWho's summary includes it. addFinding's rank guard makes this
    // idempotent.
    seedLocalFindings();
    if (!summary) return;
    const linked = getLinkedCharacters(jobId);
    for (const f of mirrorFindings(summary, declared, linked)) {
      const { declared: isDeclared, ...finding } = f;
      addFinding(jobId, finding);
      fillFindingDetails(jobId, finding.name, finding.realm, finding);
      if (!isDeclared) mirrored[finding.source] = (mirrored[finding.source] ?? 0) + 1;
    }
    setGuildHistory(jobId, mirrorGuildHistory(summary));
    try {
      const discord = await deps.confirm(jobId, applicant.region, job.applicant_discord);
      logger.info(
        'Intel',
        `Job #${jobId}: ${discord.confirmed} Discord-confirmed, ${discord.mismatched} mismatched, ` +
          `${discord.backLinked} declaring an applicant character as their main`,
      );
    } catch (error) {
      // The confirmation pass is a bonus signal; losing it must not lose the summary.
      logger.warn('Intel', `Job #${jobId}: Discord confirmation failed: ${error}`);
    }
  };

  const finish = async (outcome: SummaryOutcome): Promise<void> => {
    setPhase(jobId, 'done');
    // A link appended after the last poll replays the job; nothing else does.
    setStatus(jobId, topUpRequested(jobId) ? 'pending' : 'done');
    await publish(outcome);
  };

  const degrade = async (reason: string): Promise<void> => {
    if (deps.fallback) {
      // Loud on purpose: the fallback spends this job's Warcraft Logs points on
      // the legacy sweep, against the budget the bot shares with SlashWho.
      logger.warn(
        'Intel',
        `Job #${jobId}: SLASHWHO_FALLBACK_SWEEP fired (${reason}); running the legacy sweep`,
      );
      logOutcome('fallback');
      setStatus(jobId, 'pending');
      await deps.fallback(jobId);
      return;
    }
    summary = null;
    seedLocalFindings();
    setPhase(jobId, 'done');
    setStatus(jobId, topUpRequested(jobId) ? 'pending' : 'done');
    await publish('unavailable', { reason });
    logOutcome('unavailable');
  };

  try {
    seedLocalFindings();
    const { root } = await ensureCreated();
    await publish('collecting');
    setPhase(jobId, 'logs');

    for (;;) {
      await topUp(root);
      const status = await deps.client.getStatus(root);
      polls += 1;
      if (transitions[transitions.length - 1] !== status.state) transitions.push(status.state);

      // `snapshotId` is the publish gate: status and summary must agree on it,
      // or a snapshot published between the two reads is caught and re-read.
      // A finished dossier may carry no snapshot at all (nothing collectable);
      // null === null still agrees, so it publishes instead of polling to the
      // deadline.
      if (status.state !== 'collecting') {
        const read = await deps.client.getDossier(root);
        if (read.state !== 'collecting' && read.snapshotId === status.snapshotId) {
          summary = read;
          await mirror();
          await finish('published');
          logOutcome(`published (${read.state})`);
          return;
        }
      }

      if (now().getTime() - started >= deps.deadlineMs) {
        // Publish what exists. Nothing re-runs a done job on its own; the
        // collection carries on server-side and the dossier link shows it.
        summary = await deps.client.getDossier(root);
        await mirror();
        await finish('deadline');
        logOutcome('deadline');
        return;
      }
      await sleep(deps.pollIntervalMs);
    }
  } catch (error) {
    const terminal = terminalReason(error, applicant);
    if (terminal) {
      // Logged once per job; at error level for credentials, since every job
      // will fail the same way until the key is fixed.
      const message = `Job #${jobId}: SlashWho unavailable: ${error}`;
      const auth =
        terminal.source instanceof HttpError &&
        (terminal.source.status === 401 || terminal.source.status === 403);
      if (auth) logger.error('Intel', message);
      else logger.warn('Intel', message);
      await degrade(terminal.reason);
      return;
    }

    let decision = classifyError(error, job.attempts + 1);
    // Once the dossier exists, SlashWho keeps collecting whether or not the bot
    // is listening, so a transient fault (a 5xx after retries, a timeout) is a
    // reason to look again later, not to publish "unavailable" over a dossier
    // that is about to be ready. Before the create, nothing was started.
    const transient = !decision.pause && state !== null;
    if (transient) {
      decision = { pause: true, service: 'slashwho', resumeAfterMs: backoffMs(job.attempts + 1) };
      logger.warn('Intel', `Job #${jobId}: SlashWho request failed, will retry: ${error}`);
    }
    if (decision.pause) {
      const ageEpochMs = Math.max(
        parseUtcTimestamp(job.created_at).getTime(),
        topUpState?.reopenedAt
          ? parseUtcTimestamp(topUpState.reopenedAt).getTime()
          : Number.NEGATIVE_INFINITY,
      );
      const exhausted =
        job.attempts + 1 >= MAX_JOB_ATTEMPTS || now().getTime() - ageEpochMs >= MAX_JOB_AGE_MS;
      // Officer copy for why it stopped; the default reads "rate limited".
      const reason = transient ? 'SlashWho could not be reached' : undefined;
      if (exhausted) {
        setStatus(jobId, 'failed');
        await publish('abandoned', { reason });
        logOutcome('abandoned');
        return;
      }
      pauseJob(jobId, decision.service ?? 'slashwho', decision.resumeAfterMs ?? 0);
      const paused = getJob(jobId);
      await publish('paused', {
        retryAt: paused?.resume_after ? new Date(paused.resume_after) : undefined,
        reason,
      });
      logOutcome(`paused until ${paused?.resume_after}`);
      return;
    }

    logger.warn('Intel', `Job #${jobId}: SlashWho request failed: ${error}`);
    await degrade('it could not be reached');
  }
}

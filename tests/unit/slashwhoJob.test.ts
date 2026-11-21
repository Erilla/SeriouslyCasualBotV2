import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { closeDatabase, getDatabase } from '../../src/database/db.js';
import { createTables } from '../../src/database/schema.js';

vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from '../../src/services/logger.js';
import {
  createJob,
  getFindings,
  getGuildHistory,
  getJob,
  requestTopUp,
  setApplicantCharacters,
  setLinkedCharacters,
  setMessageIds,
} from '../../src/functions/applications/intel/jobStore.js';
import {
  runSlashWhoJob,
  type SlashWhoRunDeps,
} from '../../src/functions/applications/intel/slashwhoJob.js';
import { trialRealm } from '../../src/functions/raids/ensureTrialRaiders.js';
import { HttpError } from '../../src/services/httpClient.js';
import type {
  CreateDossierResult,
  DossierStatus,
  DossierSummary,
  SlashWhoClient,
} from '../../src/services/slashwho.js';

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/slashwho/bot-client-v1.json', import.meta.url), 'utf8'),
) as Record<string, { response: unknown }>;

const SNAPSHOT = '13af3173-e97c-4c78-a6cb-a54b647b209f';
const root = { region: 'eu', realm: 'silvermoon', name: 'ryii' };
const ryii = { region: 'eu', realm: 'silvermoon', name: 'Ryii' };
const alt = { region: 'eu', realm: 'silvermoon', name: 'Altii' };

const readySummary = (): DossierSummary =>
  structuredClone(fixture.summary.response) as DossierSummary;

function summaryWith(over: Partial<DossierSummary>): DossierSummary {
  return { ...readySummary(), ...over };
}

const status = (state: DossierStatus['state'], snapshotId: string | null = SNAPSHOT) => ({
  state,
  snapshotId,
  lastCollectedAt: null,
  evidenceRunIds: [],
});

function createResult(over: Partial<CreateDossierResult> = {}): CreateDossierResult {
  return {
    root,
    ...status('collecting', null),
    outcomes: [{ key: root, outcome: 'queued' }],
    ...over,
  };
}

/** A programmable stand-in for SlashWho: no network, every call recorded. */
function fakeClient(over: Partial<SlashWhoClient> = {}) {
  return {
    ensureDossier: vi.fn<SlashWhoClient['ensureDossier']>(async () => createResult()),
    getStatus: vi.fn<SlashWhoClient['getStatus']>(async () => status('ready')),
    getDossier: vi.fn<SlashWhoClient['getDossier']>(async () => readySummary()),
    addDossierCharacter: vi.fn<SlashWhoClient['addDossierCharacter']>(async () => ({
      kind: 'linked' as const,
    })),
    refreshDossier: vi.fn<SlashWhoClient['refreshDossier']>(async () => ({
      mode: 'full',
      lastCollectedAt: null,
    })),
    ...over,
  };
}

function rateLimited(): HttpError {
  return new HttpError({
    service: 'slashwho',
    status: 429,
    attempts: 1,
    message: 'rate limited',
    retryAfterMs: 120_000,
  });
}

function httpError(status: number): HttpError {
  return new HttpError({ service: 'slashwho', status, attempts: 1, message: `${status}` });
}

describe('runSlashWhoJob', () => {
  let jobId: number;
  let clock: number;
  let editMessage: ReturnType<typeof vi.fn<SlashWhoRunDeps['editMessage']>>;

  function deps(client: SlashWhoClient, over: Partial<SlashWhoRunDeps> = {}): SlashWhoRunDeps {
    return {
      client,
      editMessage,
      confirm: vi.fn(async () => ({ confirmed: 0, mismatched: 0, backLinked: 0 })),
      dossierBaseUrl: 'https://slashwho.com',
      pollIntervalMs: 5000,
      deadlineMs: 600_000,
      // A fake clock the sleep advances, so the deadline is reachable instantly.
      now: () => new Date(clock),
      sleep: async (ms) => {
        clock += ms;
      },
      ...over,
    };
  }

  /** The last body published to each of the three messages. */
  function lastBodies(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [, messageId, description] of editMessage.mock.calls) out[messageId] = description;
    return out;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    clock = Date.parse('2026-11-21T12:00:00Z');
    editMessage = vi.fn<SlashWhoRunDeps['editMessage']>(async () => {});
    createTables(getDatabase(':memory:'));
    getDatabase()
      .prepare(
        `INSERT INTO applications (id, applicant_user_id, status, character_name)
         VALUES (1, 'u', 'active', 'Ryii')`,
      )
      .run();
    jobId = createJob({
      applicationId: 1,
      targetChannelId: 'chan',
      character: ryii,
      applicantDiscord: 'ryii_discord',
    });
    setApplicantCharacters(jobId, [ryii, alt]);
    setMessageIds(jobId, { alts: 'ALTS', guilds: 'GUILDS', logs: 'LOGS' });
  });
  afterEach(() => closeDatabase());

  it('makes ONE create carrying every declared character, and only Raider.IO URLs', async () => {
    const client = fakeClient();
    await runSlashWhoJob(jobId, deps(client));

    expect(client.ensureDossier).toHaveBeenCalledTimes(1);
    const [urls] = client.ensureDossier.mock.calls[0];
    expect(urls).toEqual([
      'https://raider.io/characters/eu/silvermoon/Ryii',
      'https://raider.io/characters/eu/silvermoon/Altii',
    ]);
    // Nothing identifying the Discord side ever leaves the bot.
    const sent = JSON.stringify([
      ...client.ensureDossier.mock.calls,
      ...client.addDossierCharacter.mock.calls,
    ]);
    expect(sent).not.toMatch(/ryii_discord|chan|ALTS|"1"/);
  });

  it('publishes ready as one summary embed plus pointers, with the dossier link', async () => {
    await runSlashWhoJob(jobId, deps(fakeClient()));

    expect(getJob(jobId)?.status).toBe('done');
    const bodies = lastBodies();
    expect(bodies.ALTS).toContain('**Applicant summary** — Ryii');
    expect(bodies.ALTS).toContain('https://slashwho.com/dossiers/eu/silvermoon/ryii');
    expect(bodies.ALTS).toContain('Seriously Casual');
    expect(bodies.GUILDS).toContain('in the summary above');
    expect(bodies.LOGS).toContain('in the summary above');
    for (const body of Object.values(bodies)) expect(body).not.toMatch(/searching|fetching/);
    // Compact summary is bounded, so nothing is ever paged.
    expect(editMessage.mock.calls.every((call) => call[4] === undefined)).toBe(true);
  });

  it('publishes partial with its limitations note', async () => {
    const partial = summaryWith({
      state: 'partial',
      limitations: [{ code: 'private', affects: 'kill_history', character: root }],
    });
    const client = fakeClient({
      getStatus: vi.fn(async () => status('partial')),
      getDossier: vi.fn(async () => partial),
    });
    await runSlashWhoJob(jobId, deps(client));

    expect(getJob(jobId)?.status).toBe('done');
    expect(lastBodies().ALTS).toContain('*Partial');
    expect(lastBodies().ALTS).toContain('profile is private');
  });

  it('mirrors findings and guild history into the job tables', async () => {
    const summary = summaryWith({
      characters: [
        ...readySummary().characters,
        {
          key: { region: 'eu', realm: 'silvermoon', name: 'printy' },
          displayName: 'Printy',
          className: 'Mage',
          guild: null,
          source: 'fingerprint_derived',
          confidence: null,
          evidenceState: 'complete',
          pending: false,
        },
      ],
    });
    await runSlashWhoJob(jobId, deps(fakeClient({ getDossier: vi.fn(async () => summary) })));

    const findings = getFindings(jobId);
    expect(findings.find((f) => f.name === 'Ryii')).toMatchObject({
      source: 'application',
      className: 'Mage',
      guildName: 'Seriously Casual',
    });
    // Declared but not in SlashWho's list yet: still recorded as the applicant's own.
    expect(findings.find((f) => f.name === 'Altii')?.source).toBe('application');
    expect(findings.find((f) => f.name === 'Printy')).toMatchObject({
      source: 'fingerprint',
      confidence: null,
    });
    expect(lastBodies().ALTS).toContain('fingerprint match, no score');
    expect(lastBodies().ALTS).not.toContain('100%');
    expect(getGuildHistory(jobId)[0]).toMatchObject({ guildName: 'Seriously Casual' });
    // trialRealm keeps reading the job row exactly as before.
    expect(trialRealm(getDatabase(), { application_id: 1 })).toEqual({
      realm: 'silvermoon',
      region: 'eu',
    });
  });

  it('adds a link pasted mid-run exactly once, and lists it', async () => {
    let polls = 0;
    const client = fakeClient({
      getStatus: vi.fn(async () => {
        polls += 1;
        if (polls === 1) {
          // What harvestLinkedCharacters does while the job is running.
          setLinkedCharacters(jobId, [{ region: 'eu', realm: 'silvermoon', name: 'Pasted' }]);
          requestTopUp(jobId);
          return status('collecting', null);
        }
        if (polls === 2) return status('collecting', null);
        return status('ready');
      }),
    });
    await runSlashWhoJob(jobId, deps(client));

    expect(client.addDossierCharacter).toHaveBeenCalledTimes(1);
    expect(client.addDossierCharacter.mock.calls[0][1]).toBe(
      'https://raider.io/characters/eu/silvermoon/Pasted',
    );
    expect(lastBodies().ALTS).toContain('Pasted');
    // The link joined this run, so no replay is queued.
    expect(getJob(jobId)?.status).toBe('done');
  });

  it('keeps a link pasted while add-character is in flight queued for a replay', async () => {
    setLinkedCharacters(jobId, [{ region: 'eu', realm: 'silvermoon', name: 'First' }]);
    requestTopUp(jobId);
    let pasted = false;
    const client = fakeClient({
      addDossierCharacter: vi.fn(async () => {
        if (pasted) return { kind: 'linked' as const };
        pasted = true;
        // A second link lands mid-request, and the dossier is ready on this poll.
        setLinkedCharacters(jobId, [
          { region: 'eu', realm: 'silvermoon', name: 'First' },
          { region: 'eu', realm: 'silvermoon', name: 'Second' },
        ]);
        requestTopUp(jobId);
        return { kind: 'linked' as const };
      }),
    });
    await runSlashWhoJob(jobId, deps(client));

    // Not finished: the replay picks up Second rather than dropping it.
    expect(getJob(jobId)?.status).toBe('pending');
    await runSlashWhoJob(jobId, deps(client));
    expect(client.addDossierCharacter.mock.calls.map((c) => c[1])).toEqual([
      'https://raider.io/characters/eu/silvermoon/First',
      'https://raider.io/characters/eu/silvermoon/Second',
    ]);
    expect(getJob(jobId)?.status).toBe('done');
  });

  it('publishes a finished dossier that carries no snapshot id without waiting out the deadline', async () => {
    const client = fakeClient({
      getStatus: vi.fn(async () => status('partial', null)),
      getDossier: vi.fn(async () => summaryWith({ state: 'partial', snapshotId: null })),
    });
    await runSlashWhoJob(jobId, deps(client));

    expect(client.getStatus).toHaveBeenCalledTimes(1);
    expect(getJob(jobId)?.status).toBe('done');
    expect(lastBodies().ALTS).toContain('*Partial');
    expect(lastBodies().ALTS).not.toContain('Still collecting');
  });

  it('pauses, not "unavailable", on a 5xx once the dossier exists, then resumes', async () => {
    const client = fakeClient({
      getStatus: vi.fn<SlashWhoClient['getStatus']>(async () => {
        throw httpError(503);
      }),
    });
    await runSlashWhoJob(jobId, deps(client));

    const paused = getJob(jobId)!;
    expect(paused.status).toBe('paused');
    expect(paused.paused_service).toBe('slashwho');
    const bodies = lastBodies();
    expect(bodies.ALTS).not.toContain('research unavailable');
    expect(bodies.ALTS).toMatch(/SlashWho could not be reached\. Retrying <t:\d+:R>/);
    expect(bodies.ALTS).not.toContain('Rate limited');

    client.getStatus.mockImplementation(async () => status('ready'));
    await runSlashWhoJob(jobId, deps(client));
    expect(getJob(jobId)?.status).toBe('done');
    expect(lastBodies().ALTS).toContain('**Applicant summary**');
    expect(client.ensureDossier).toHaveBeenCalledTimes(1);
  });

  it('reuses the dossier on a reopened job instead of creating again', async () => {
    const client = fakeClient();
    await runSlashWhoJob(jobId, deps(client));
    requestTopUp(jobId);
    await runSlashWhoJob(jobId, deps(client));
    expect(client.ensureDossier).toHaveBeenCalledTimes(1);
    expect(client.getDossier).toHaveBeenCalledTimes(2);
  });

  it('retries a rate-limited create outcome through add-character', async () => {
    const client = fakeClient({
      ensureDossier: vi.fn(async () =>
        createResult({
          outcomes: [
            { key: root, outcome: 'queued' },
            { key: { region: 'eu', realm: 'silvermoon', name: 'altii' }, outcome: 'rate_limited' },
          ],
          retryAfterSeconds: 30,
        }),
      ),
    });
    await runSlashWhoJob(jobId, deps(client));
    expect(client.addDossierCharacter).toHaveBeenCalledWith(
      root,
      'https://raider.io/characters/eu/silvermoon/Altii',
    );
  });

  it('waits for the snapshot ids to agree before publishing', async () => {
    let reads = 0;
    const client = fakeClient({
      getDossier: vi.fn(async () => {
        reads += 1;
        // A snapshot published between the status and summary reads.
        return reads === 1
          ? summaryWith({ snapshotId: '00000000-0000-4000-8000-000000000000' })
          : readySummary();
      }),
    });
    await runSlashWhoJob(jobId, deps(client));
    expect(client.getDossier).toHaveBeenCalledTimes(2);
    expect(client.getStatus).toHaveBeenCalledTimes(2);
  });

  it('pauses on a 429 with the rate-limit note, then resumes without re-creating', async () => {
    const client = fakeClient({
      getStatus: vi.fn<SlashWhoClient['getStatus']>(async () => {
        throw rateLimited();
      }),
    });
    await runSlashWhoJob(jobId, deps(client));

    const paused = getJob(jobId)!;
    expect(paused.status).toBe('paused');
    expect(paused.paused_service).toBe('slashwho');
    expect(lastBodies().ALTS).toMatch(/Rate limited on SlashWho\. Retrying <t:\d+:R>/);
    for (const body of Object.values(lastBodies())) expect(body).not.toMatch(/searching|fetching/);

    client.getStatus.mockImplementation(async () => status('ready'));
    await runSlashWhoJob(jobId, deps(client));
    expect(getJob(jobId)?.status).toBe('done');
    expect(client.ensureDossier).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a 401 on create', 'ensureDossier', 401],
    ['a 404 on create', 'ensureDossier', 404],
    ['a 404 on status', 'getStatus', 404],
  ] as const)('publishes "research unavailable" and finishes on %s', async (_, method, code) => {
    const client = fakeClient({
      [method]: vi.fn(async () => {
        throw httpError(code);
      }),
    });
    await runSlashWhoJob(jobId, deps(client));

    expect(getJob(jobId)?.status).toBe('done');
    const bodies = lastBodies();
    expect(bodies.ALTS).toContain('**Applicant research unavailable**');
    expect(bodies.ALTS).toContain('Ryii');
    expect(bodies.GUILDS).toContain('not checked');
    expect(bodies.LOGS).toContain('not checked');
    const failureLogs = [
      ...vi.mocked(logger.error).mock.calls,
      ...vi.mocked(logger.warn).mock.calls,
    ].filter(([, message]) => String(message).includes('SlashWho unavailable'));
    expect(failureLogs).toHaveLength(1);
  });

  it('publishes what exists at the deadline and leaves no "searching…"', async () => {
    const collecting = summaryWith({
      state: 'collecting',
      snapshotId: null,
      raids: [],
      guildHistory: [],
    });
    const client = fakeClient({
      getStatus: vi.fn(async () => status('collecting', null)),
      getDossier: vi.fn(async () => collecting),
    });
    await runSlashWhoJob(jobId, deps(client, { deadlineMs: 20_000 }));

    expect(getJob(jobId)?.status).toBe('done');
    expect(client.getStatus.mock.calls.length).toBe(5);
    const bodies = lastBodies();
    expect(bodies.ALTS).toContain('Still collecting');
    expect(bodies.ALTS).toContain('https://slashwho.com/dossiers/eu/silvermoon/ryii');
    for (const body of Object.values(bodies)) expect(body).not.toMatch(/searching|fetching/);
  });

  it('spends nothing on the legacy sweep when SlashWho is down and the fallback is off', async () => {
    const fallback = vi.fn(async () => {});
    const client = fakeClient({
      ensureDossier: vi.fn(async () => {
        throw httpError(503);
      }),
    });
    await runSlashWhoJob(jobId, deps(client));
    expect(fallback).not.toHaveBeenCalled();
    expect(lastBodies().ALTS).toContain('it could not be reached');
    expect(getJob(jobId)?.status).toBe('done');
  });

  it('runs the legacy sweep, loudly, when the fallback is on', async () => {
    const fallback = vi.fn(async () => {});
    const client = fakeClient({
      ensureDossier: vi.fn(async () => {
        throw httpError(503);
      }),
    });
    await runSlashWhoJob(jobId, deps(client, { fallback }));
    expect(fallback).toHaveBeenCalledWith(jobId);
    expect(
      vi
        .mocked(logger.warn)
        .mock.calls.some(([, m]) => String(m).includes('SLASHWHO_FALLBACK_SWEEP fired')),
    ).toBe(true);
  });

  it('logs one info line per job with the outcome', async () => {
    await runSlashWhoJob(jobId, deps(fakeClient()));
    const lines = vi
      .mocked(logger.info)
      .mock.calls.filter(([, m]) => String(m).includes(`Job #${jobId} [slashwho]`));
    expect(lines).toHaveLength(1);
    expect(String(lines[0][1])).toMatch(/published \(ready\): dossier eu\/silvermoon\/ryii/);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, getDatabase } from '../../src/database/db.js';
import { createTables } from '../../src/database/schema.js';

vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/services/blizzard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/blizzard.js')>();
  return { ...actual, getCharacterFingerprint: vi.fn() };
});

import { getCharacterFingerprint, FINGERPRINT_TTL_MS } from '../../src/services/blizzard.js';
import { HttpError } from '../../src/services/httpClient.js';
import { WclPointsExhausted } from '../../src/services/warcraftlogs.js';
import {
  addFinding,
  createJob,
  dueJobs,
  getAnchorFingerprint,
  getFindings,
  getJob,
  getSweepTruncated,
  isSelfDeclared,
  needsDiscordConfirmation,
  requestTopUp,
  setAnchorFingerprint,
  setLinkedCharacters,
  setMessageIds,
  setStatus,
  setSweepTruncated,
  topUpRequested,
} from '../../src/functions/applications/intel/jobStore.js';
import { runJob, type RunDeps } from '../../src/functions/applications/intel/runJob.js';
import { renderFoundCharacters } from '../../src/functions/applications/intel/render.js';
import type { IntelFinding } from '../../src/functions/applications/intel/jobStore.js';
import type { MythicKillDate } from '../../src/services/raiderioInternal.js';

const primary = { region: 'eu', realm: 'draenor', name: 'Primary' };
const linked = { region: 'eu', realm: 'silvermoon', name: 'Linkedmage' };
const fixedNow = new Date('2026-08-10T12:34:56.000Z');

function deps(over: Partial<RunDeps> = {}): RunDeps {
  return {
    editMessage: vi.fn(async () => {}),
    discover: vi.fn(async () => ({ truncated: false })),
    gather: vi.fn(async () => []),
    confirm: vi.fn(async () => ({ confirmed: 0, mismatched: 0, backLinked: 0 })),
    getZoneCatalogue: vi.fn(async () => []),
    getMythicKillCount: vi.fn(async () => 0),
    getRaidReports: vi.fn(async () => []),
    getMythicKillDates: vi.fn(async () => [] as MythicKillDate[]),
    paceMs: 0,
    tierOrdinals: [35],
    now: () => fixedNow,
    ...over,
  } as RunDeps;
}

function finding(source: IntelFinding['source'], confidence: number | null): IntelFinding {
  return {
    name: linked.name,
    realm: linked.realm,
    className: 'Mage',
    guildName: null,
    guildRealm: null,
    source,
    confidence,
    discordStatus: null,
    discordProfile: null,
  };
}

describe('applicant intel linked-character top-ups', () => {
  let jobId: number;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
    createTables(getDatabase(':memory:'));
    jobId = createJob({ applicationId: 1, targetChannelId: 'chan', character: primary });
    setMessageIds(jobId, { alts: 'ALTS', guilds: 'GUILDS', logs: 'LOGS' });
  });

  afterEach(() => {
    vi.useRealTimers();
    closeDatabase();
  });

  it('passes linked seeds into discovery and persists a newly fetched primary anchor', async () => {
    const fingerprint = new Map<number, number>([
      [1, 11],
      [2, 22],
    ]);
    vi.mocked(getCharacterFingerprint).mockResolvedValue(fingerprint);
    setLinkedCharacters(jobId, [linked]);

    const discover = vi.fn(async (_jobId, primaryArg, _applicants, linkedSeeds, discoverDeps) => {
      expect(linkedSeeds).toEqual([linked]);
      expect(await discoverDeps.getAnchorFingerprint(primaryArg)).toEqual(fingerprint);
      return { truncated: false };
    });

    await runJob(jobId, deps({ discover }));

    expect(getAnchorFingerprint(jobId)).toEqual({
      ...primary,
      entries: [...fingerprint.entries()],
      fetchedAt: fixedNow.toISOString(),
    });
  });

  it('reuses a matching durable anchor without fetching the primary again', async () => {
    setAnchorFingerprint(jobId, {
      ...primary,
      entries: [[7, 77]],
      fetchedAt: '2026-08-09T00:00:00.000Z',
    });

    const discover = vi.fn(async (_jobId, primaryArg, _applicants, _linkedSeeds, discoverDeps) => {
      expect(await discoverDeps.getAnchorFingerprint(primaryArg)).toEqual(new Map([[7, 77]]));
      return { truncated: false };
    });

    await runJob(jobId, deps({ discover }));

    expect(getCharacterFingerprint).not.toHaveBeenCalled();
  });

  /**
   * A top-up can reopen a job days later and requestTopUp resets `attempts`, so
   * the durable anchor can outlive the freshness the API cache would enforce.
   * Comparing candidates against a baseline from before the applicant earned more
   * achievements makes them look less like their own alts the longer the
   * application stays open.
   */
  it('re-fetches an anchor older than the fingerprint TTL', async () => {
    const fresh = new Map<number, number>([[9, 99]]);
    vi.mocked(getCharacterFingerprint).mockResolvedValue(fresh);
    setAnchorFingerprint(jobId, {
      ...primary,
      entries: [[7, 77]],
      fetchedAt: new Date(fixedNow.getTime() - FINGERPRINT_TTL_MS - 1).toISOString(),
    });

    const discover = vi.fn(async (_jobId, primaryArg, _applicants, _linkedSeeds, discoverDeps) => {
      expect(await discoverDeps.getAnchorFingerprint(primaryArg)).toEqual(fresh);
      return { truncated: false };
    });

    await runJob(jobId, deps({ discover }));

    expect(getCharacterFingerprint).toHaveBeenCalled();
    expect(getAnchorFingerprint(jobId)?.entries).toEqual([[9, 99]]);
  });

  it('keeps an anchor that is still within the fingerprint TTL', async () => {
    setAnchorFingerprint(jobId, {
      ...primary,
      entries: [[7, 77]],
      fetchedAt: new Date(fixedNow.getTime() - FINGERPRINT_TTL_MS + 60_000).toISOString(),
    });

    await runJob(jobId, deps({ discover: vi.fn(async () => ({ truncated: false })) }));

    expect(getCharacterFingerprint).not.toHaveBeenCalled();
  });

  it('re-fetches and replaces an anchor whose primary identity mismatches', async () => {
    setAnchorFingerprint(jobId, {
      region: 'eu',
      realm: 'draenor',
      name: 'Other',
      entries: [[1, 1]],
      fetchedAt: '2026-08-09T00:00:00.000Z',
    });
    vi.mocked(getCharacterFingerprint).mockResolvedValue(new Map([[9, 99]]));

    const discover = vi.fn(async (_jobId, primaryArg, _applicants, _linkedSeeds, discoverDeps) => {
      await discoverDeps.getAnchorFingerprint(primaryArg);
      return { truncated: false };
    });
    await runJob(jobId, deps({ discover }));

    expect(getCharacterFingerprint).toHaveBeenCalledWith(primary);
    expect(getAnchorFingerprint(jobId)).toMatchObject({
      ...primary,
      entries: [[9, 99]],
    });
  });

  it('preserves fingerprint confidence when stronger linked evidence wins', () => {
    addFinding(jobId, finding('fingerprint', 74));
    addFinding(jobId, finding('linked', null));

    expect(getFindings(jobId)[0]).toMatchObject({ source: 'linked', confidence: 74 });
  });

  it('treats only application findings as self-declared', () => {
    expect(isSelfDeclared('application')).toBe(true);
    expect(isSelfDeclared('linked')).toBe(false);
  });

  it('sends linked findings through Discord confirmation', () => {
    expect(needsDiscordConfirmation('linked')).toBe(true);
    expect(needsDiscordConfirmation('application')).toBe(false);
  });

  it('renders linked evidence as undeclared rather than self-declared', () => {
    const body = renderFoundCharacters([finding('linked', null)], primary.name, primary.region)[0];

    expect(body).toContain('undeclared');
    expect(body).toContain('linked in the conversation');
    expect(body).not.toContain('from the application');
    expect(body).not.toContain('100% confidence');
  });

  it('consumes the current request at start and leaves pending when another append arrives', async () => {
    setStatus(jobId, 'done');
    requestTopUp(jobId);

    const discover = vi.fn(async () => {
      expect(topUpRequested(jobId)).toBe(false);
      return { truncated: false };
    });
    const gather = vi.fn(async () => {
      expect(requestTopUp(jobId)).toBe('queued');
      return [];
    });

    await runJob(jobId, deps({ discover, gather }));

    expect(getJob(jobId)?.status).toBe('pending');
    expect(topUpRequested(jobId)).toBe(true);
  });

  it('uses the reopen epoch instead of the original creation time for abandonment age', async () => {
    getDatabase()
      .prepare('UPDATE applicant_intel_jobs SET created_at = ? WHERE id = ?')
      .run('2026-07-01 00:00:00', jobId);
    setStatus(jobId, 'done');
    requestTopUp(jobId);

    await runJob(
      jobId,
      deps({
        discover: vi.fn(async () => {
          throw new HttpError({
            service: 'blizzard',
            status: 429,
            attempts: 1,
            message: 'rate limited',
            retryAfterMs: 60_000,
          });
        }),
      }),
    );

    expect(getJob(jobId)?.status).toBe('paused');
  });

  it('leaves existing guild and log messages untouched when a top-up pauses before those phases', async () => {
    setStatus(jobId, 'done');
    requestTopUp(jobId);
    const editMessage = vi.fn(async () => {});

    await runJob(
      jobId,
      deps({
        editMessage,
        discover: vi.fn(async () => {
          throw new HttpError({
            service: 'blizzard',
            status: 429,
            attempts: 1,
            message: 'rate limited',
            retryAfterMs: 60_000,
          });
        }),
      }),
    );

    expect(editMessage.mock.calls.map(([, messageId]) => messageId)).toEqual(['ALTS']);
  });

  it('leaves existing guild and log messages untouched when an in-run append requests a top-up', async () => {
    const messages = new Map([
      ['ALTS', 'existing alts'],
      ['GUILDS', 'existing guild history'],
      ['LOGS', 'existing logs'],
    ]);
    const editMessage = vi.fn(async (_channelId: string, messageId: string, body: string) => {
      messages.set(messageId, body);
    });

    await runJob(
      jobId,
      deps({
        editMessage,
        discover: vi.fn(async () => {
          setLinkedCharacters(jobId, [linked]);
          expect(requestTopUp(jobId)).toBe('queued');
          throw new HttpError({
            service: 'blizzard',
            status: 429,
            attempts: 1,
            message: 'rate limited',
            retryAfterMs: 60_000,
          });
        }),
      }),
    );

    expect(getJob(jobId)?.status).toBe('paused');
    expect(topUpRequested(jobId)).toBe(true);
    expect(editMessage.mock.calls.map(([, messageId]) => messageId)).toEqual(['ALTS']);
    expect(messages.get('GUILDS')).toBe('existing guild history');
    expect(messages.get('LOGS')).toBe('existing logs');
  });

  it('leaves existing guild and log messages untouched when an append arrives during the alts edit', async () => {
    const messages = new Map([
      ['ALTS', 'existing alts'],
      ['GUILDS', 'existing guild history'],
      ['LOGS', 'existing logs'],
    ]);
    const editMessage = vi.fn(async (_channelId: string, messageId: string, body: string) => {
      messages.set(messageId, body);
      if (messageId === 'ALTS') {
        setLinkedCharacters(jobId, [linked]);
        expect(requestTopUp(jobId)).toBe('queued');
      }
    });

    await runJob(
      jobId,
      deps({
        editMessage,
        discover: vi.fn(async () => {
          throw new HttpError({
            service: 'blizzard',
            status: 429,
            attempts: 1,
            message: 'rate limited',
            retryAfterMs: 60_000,
          });
        }),
      }),
    );

    expect(getJob(jobId)?.status).toBe('paused');
    expect(topUpRequested(jobId)).toBe(true);
    expect(editMessage.mock.calls.map(([, messageId]) => messageId)).toEqual(['ALTS']);
    expect(messages.get('GUILDS')).toBe('existing guild history');
    expect(messages.get('LOGS')).toBe('existing logs');
  });

  it('keeps partial top-up message protection when a paused run resumes', async () => {
    setStatus(jobId, 'done');
    requestTopUp(jobId);
    const editMessage = vi.fn(async () => {});
    const discover = vi.fn(async () => {
      throw new HttpError({
        service: 'blizzard',
        status: 429,
        attempts: 1,
        message: 'rate limited',
        retryAfterMs: 60_000,
      });
    });
    const runDeps = deps({ editMessage, discover });

    await runJob(jobId, runDeps);
    expect(editMessage.mock.calls.map(([, messageId]) => messageId)).toEqual(['ALTS']);
    expect(getJob(jobId)?.status).toBe('paused');

    editMessage.mockClear();
    await runJob(jobId, runDeps);

    expect(editMessage.mock.calls.map(([, messageId]) => messageId)).toEqual(['ALTS']);
    expect(getJob(jobId)?.status).toBe('paused');
  });

  it.each([
    [
      'HTTP rate limit',
      () =>
        new HttpError({
          service: 'blizzard',
          status: 429,
          attempts: 1,
          message: 'rate limited',
          retryAfterMs: 60_000,
        }),
    ],
    ['WarcraftLogs points exhaustion', () => new WclPointsExhausted(9_500, 10_000)],
  ])('requeues and processes an append during exhausted %s abandonment', async (_label, error) => {
    getDatabase().prepare('UPDATE applicant_intel_jobs SET attempts = 19 WHERE id = ?').run(jobId);
    const discover = vi
      .fn()
      .mockImplementationOnce(async () => {
        setLinkedCharacters(jobId, [linked]);
        expect(requestTopUp(jobId)).toBe('queued');
        throw error();
      })
      .mockImplementationOnce(async (_jobId, _primaryArg, _applicants, linkedSeeds) => {
        expect(linkedSeeds).toEqual([linked]);
        return { truncated: false };
      });
    const runDeps = deps({ discover });

    await runJob(jobId, runDeps);

    expect(getJob(jobId)?.status).toBe('pending');
    expect(topUpRequested(jobId)).toBe(true);
    expect(dueJobs(fixedNow.toISOString()).map((job) => job.id)).toContain(jobId);

    await runJob(jobId, runDeps);

    expect(discover).toHaveBeenCalledTimes(2);
    expect(getJob(jobId)?.status).toBe('done');
    expect(topUpRequested(jobId)).toBe(false);
  });

  it('recomputes truncation instead of retaining the previous run result', async () => {
    setSweepTruncated(jobId, true);
    setStatus(jobId, 'done');
    requestTopUp(jobId);

    await runJob(jobId, deps());

    expect(getSweepTruncated(jobId)).toBe(false);
  });
});

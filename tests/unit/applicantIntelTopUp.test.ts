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

import { getCharacterFingerprint } from '../../src/services/blizzard.js';
import { HttpError } from '../../src/services/httpClient.js';
import {
  addFinding,
  createJob,
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

    const discover = vi.fn(async (_jobId, applicants, linkedSeeds, discoverDeps) => {
      expect(linkedSeeds).toEqual([linked]);
      expect(await discoverDeps.getAnchorFingerprint(applicants[0])).toEqual(fingerprint);
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

    const discover = vi.fn(async (_jobId, applicants, _linkedSeeds, discoverDeps) => {
      expect(await discoverDeps.getAnchorFingerprint(applicants[0])).toEqual(new Map([[7, 77]]));
      return { truncated: false };
    });

    await runJob(jobId, deps({ discover }));

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

    const discover = vi.fn(async (_jobId, applicants, _linkedSeeds, discoverDeps) => {
      await discoverDeps.getAnchorFingerprint(applicants[0]);
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

  it('recomputes truncation instead of retaining the previous run result', async () => {
    setSweepTruncated(jobId, true);
    setStatus(jobId, 'done');
    requestTopUp(jobId);

    await runJob(jobId, deps());

    expect(getSweepTruncated(jobId)).toBe(false);
  });
});

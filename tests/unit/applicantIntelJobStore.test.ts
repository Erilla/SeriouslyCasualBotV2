import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, getDatabase } from '../../src/database/db.js';
import { createTables } from '../../src/database/schema.js';
import {
  consumeTopUpRequest,
  createJob,
  getAnchorFingerprint,
  getJob,
  getLinkedCharacters,
  pauseJob,
  requestTopUp,
  setAnchorFingerprint,
  setLinkedCharacters,
  setStatus,
  topUpRequested,
} from '../../src/functions/applications/intel/jobStore.js';
import { decodeFingerprint, encodeFingerprint } from '../../src/services/blizzard.js';
import type {
  ApplicantIntelAnchorFingerprint,
  ApplicantIntelTopUpState,
} from '../../src/types/index.js';

const primary = { region: 'eu', realm: 'draenor', name: 'Primary' };

function createIntelJob(): number {
  return createJob({ applicationId: 1, targetChannelId: '1', character: primary });
}

function anchor(name: string, entries: [number, number][]): ApplicantIntelAnchorFingerprint {
  return {
    region: 'eu',
    realm: 'draenor',
    name,
    entries,
    fetchedAt: '2026-08-10T12:00:00.000Z',
  };
}

function queuePayload<T>(jobId: number, kind: string, key: string): T | null {
  const row = getDatabase()
    .prepare('SELECT payload FROM applicant_intel_queue WHERE job_id = ? AND kind = ? AND key = ?')
    .get(jobId, kind, key) as { payload: string | null } | undefined;
  return row?.payload ? (JSON.parse(row.payload) as T) : null;
}

describe('applicant intel durable queue state', () => {
  beforeEach(() => {
    createTables(getDatabase(':memory:'));
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T12:34:56.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    closeDatabase();
  });

  it('stores linked characters once by normalized canonical identity', () => {
    const jobId = createIntelJob();
    setLinkedCharacters(jobId, [
      { region: 'EU', realm: 'Draenor', name: 'Alt' },
      { region: 'eu', realm: 'draenor', name: 'alt' },
      { region: 'us', realm: 'draenor', name: 'Alt' },
    ]);

    expect(getLinkedCharacters(jobId)).toEqual([
      { region: 'EU', realm: 'Draenor', name: 'Alt' },
      { region: 'us', realm: 'draenor', name: 'Alt' },
    ]);
  });

  it('deduplicates canonically equivalent Unicode linked identities', () => {
    const jobId = createIntelJob();
    setLinkedCharacters(jobId, [
      { region: 'eu', realm: 'argent-dawn', name: 'Éowyn' },
      { region: 'EU', realm: 'ARGENT-DAWN', name: 'E\u0301OWYN' },
    ]);

    expect(getLinkedCharacters(jobId)).toEqual([
      { region: 'eu', realm: 'argent-dawn', name: 'Éowyn' },
    ]);
  });

  it('round-trips fingerprint entries through the exported gzip codec', () => {
    const entries: [number, number][] = [
      [1, 2],
      [123456, 987654321],
    ];

    const encoded = encodeFingerprint(entries);

    expect(typeof encoded).toBe('string');
    expect(encoded).not.toContain('123456');
    expect(decodeFingerprint(encoded)).toEqual(entries);
  });

  it('upserts compressed anchor state and does not cache null', () => {
    const jobId = createIntelJob();
    expect(getAnchorFingerprint(jobId)).toBeNull();

    setAnchorFingerprint(jobId, null);
    expect(getAnchorFingerprint(jobId)).toBeNull();

    setAnchorFingerprint(jobId, anchor('Primary', [[1, 2]]));
    setAnchorFingerprint(jobId, anchor('Primary', [[2, 3]]));
    setAnchorFingerprint(jobId, null);

    expect(getAnchorFingerprint(jobId)).toEqual(anchor('Primary', [[2, 3]]));
    const stored = queuePayload<{ entries: unknown }>(jobId, 'fingerprint', 'anchor');
    expect(typeof stored?.entries).toBe('string');
    expect(
      getDatabase()
        .prepare(
          "SELECT COUNT(*) AS count FROM applicant_intel_queue WHERE job_id = ? AND kind = 'fingerprint' AND key = 'anchor'",
        )
        .get(jobId),
    ).toEqual({ count: 1 });
  });

  it('reopens done and failed jobs, resetting attempts and recording reopened time', () => {
    for (const terminalStatus of ['done', 'failed'] as const) {
      const jobId = createIntelJob();
      pauseJob(jobId, 'blizzard', 60_000);
      setStatus(jobId, terminalStatus);

      expect(requestTopUp(jobId)).toBe('reopened');
      expect(getJob(jobId)).toMatchObject({ status: 'pending', attempts: 0 });
      expect(queuePayload<ApplicantIntelTopUpState>(jobId, 'topup', 'state')).toEqual({
        requested: true,
        reopenedAt: '2026-08-10T12:34:56.000Z',
      });
    }
  });

  it('only flags running and paused jobs, preserving pause timing and attempts', () => {
    const runningJob = createIntelJob();
    getDatabase()
      .prepare("UPDATE applicant_intel_jobs SET status = 'running', attempts = 3 WHERE id = ?")
      .run(runningJob);

    const pausedJob = createIntelJob();
    pauseJob(pausedJob, 'warcraftlogs', 60_000);
    const pausedBefore = getJob(pausedJob)!;

    expect(requestTopUp(runningJob)).toBe('queued');
    expect(requestTopUp(pausedJob)).toBe('queued');
    expect(getJob(runningJob)).toMatchObject({ status: 'running', attempts: 3 });
    expect(getJob(pausedJob)).toMatchObject({
      status: 'paused',
      attempts: pausedBefore.attempts,
      paused_service: pausedBefore.paused_service,
      resume_after: pausedBefore.resume_after,
    });
    expect(topUpRequested(runningJob)).toBe(true);
    expect(topUpRequested(pausedJob)).toBe(true);
  });

  it('consumes only the requested flag and preserves the reopen epoch', () => {
    const jobId = createIntelJob();
    setStatus(jobId, 'done');
    requestTopUp(jobId);

    expect(consumeTopUpRequest(jobId)).toBe(true);
    expect(topUpRequested(jobId)).toBe(false);
    expect(consumeTopUpRequest(jobId)).toBe(false);
    expect(queuePayload<ApplicantIntelTopUpState>(jobId, 'topup', 'state')).toEqual({
      requested: false,
      reopenedAt: '2026-08-10T12:34:56.000Z',
    });
  });

  it('does not create top-up state when there is no request to consume', () => {
    const jobId = createIntelJob();

    expect(consumeTopUpRequest(jobId)).toBe(false);
    expect(topUpRequested(jobId)).toBe(false);
    expect(queuePayload(jobId, 'topup', 'state')).toBeNull();
  });
});

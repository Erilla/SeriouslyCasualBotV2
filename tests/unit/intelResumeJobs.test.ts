import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { closeDatabase, getDatabase } from '../../src/database/db.js';
import { createTables } from '../../src/database/schema.js';

vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  createJob,
  pauseJob,
  setStatus,
  getJob,
} from '../../src/functions/applications/intel/jobStore.js';
import {
  resumeApplicantIntelJobs,
  recoverInterruptedJobs,
} from '../../src/functions/applications/intel/resumeJobs.js';

const character = { region: 'eu', realm: 'draenor', name: 'Brentpriest' };
const client = {} as never;

describe('resumeApplicantIntelJobs', () => {
  beforeEach(() => {
    createTables(getDatabase(':memory:'));
  });
  afterEach(() => closeDatabase());

  it('runs pending jobs', async () => {
    const id = createJob({ applicationId: 1, targetChannelId: 'c', character });
    const run = vi.fn(async () => {});
    expect(await resumeApplicantIntelJobs(client, run)).toBe(1);
    expect(run).toHaveBeenCalledWith(id);
  });

  it('skips a paused job whose wait has not elapsed', async () => {
    const id = createJob({ applicationId: 1, targetChannelId: 'c', character });
    pauseJob(id, 'blizzard', 600_000);
    const run = vi.fn(async () => {});
    expect(await resumeApplicantIntelJobs(client, run)).toBe(0);
    expect(run).not.toHaveBeenCalled();
  });

  it('keeps going when one job throws', async () => {
    createJob({ applicationId: 1, targetChannelId: 'c', character });
    createJob({ applicationId: 2, targetChannelId: 'c', character });
    let calls = 0;
    const run = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('boom');
    });
    await resumeApplicantIntelJobs(client, run);
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('recoverInterruptedJobs', () => {
  beforeEach(() => {
    createTables(getDatabase(':memory:'));
  });
  afterEach(() => closeDatabase());

  it('resets jobs left running by a crash', () => {
    const id = createJob({ applicationId: 1, targetChannelId: 'c', character });
    setStatus(id, 'running');
    expect(recoverInterruptedJobs()).toBe(1);
    expect(getJob(id)?.status).toBe('pending');
  });
});

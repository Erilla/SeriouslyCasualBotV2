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
  pruneFingerprintCache,
  editIntelMessage,
} from '../../src/functions/applications/intel/resumeJobs.js';
import { FINGERPRINT_TTL_MS } from '../../src/services/blizzard.js';
import { cacheRowCount } from '../../src/services/apiCache.js';
import { logger } from '../../src/services/logger.js';
import type { Client } from 'discord.js';

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

// ---------------------------------------------------------------------------
// FINAL REVIEW M6 — the fingerprint cache can exhaust the Railway volume, and
// `dailyBackup` amplifies whatever it finds 8x. Pruning must run on the daily
// schedule, not only at boot, and must be observable.
// ---------------------------------------------------------------------------
describe('pruneFingerprintCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createTables(getDatabase(':memory:'));
  });
  afterEach(() => closeDatabase());

  function seed(key: string, ageMs: number): void {
    getDatabase()
      .prepare('INSERT OR REPLACE INTO api_cache (key, payload, fetched_at) VALUES (?, ?, ?)')
      .run(key, '[]', new Date(Date.now() - ageMs).toISOString());
  }

  it('drops fingerprint entries past the TTL and leaves fresh ones', () => {
    seed('fingerprint:eu:draenor:old', FINGERPRINT_TTL_MS + 60_000);
    seed('fingerprint:eu:draenor:fresh', 60_000);
    expect(pruneFingerprintCache()).toBe(1);
    expect(cacheRowCount()).toBe(1);
  });

  it('never evicts the FOREVER achievements-image entries', () => {
    seed('static-data:10', 365 * 24 * 60 * 60 * 1000);
    seed('fingerprint:eu:draenor:old', FINGERPRINT_TTL_MS + 60_000);
    expect(pruneFingerprintCache()).toBe(1);
    expect(cacheRowCount()).toBe(1);
  });

  // The TTL is a disk-pressure limit; a silent regression to a week is exactly
  // what the comment on the constant exists to prevent.
  it('uses a 48-hour TTL, not a week', () => {
    expect(FINGERPRINT_TTL_MS).toBe(48 * 60 * 60 * 1000);
  });

  // Observability: gated logging is why nobody noticed the growth.
  it('always logs the number pruned and the current api_cache row count', () => {
    seed('fingerprint:eu:draenor:fresh', 60_000);
    pruneFingerprintCache();
    const infoCalls = (logger.info as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const line = infoCalls.find(
      ([, msg]) => typeof msg === 'string' && msg.includes('fingerprint cache entries'),
    );
    expect(line?.[1]).toContain('Pruned 0');
    expect(line?.[1]).toContain('api_cache now holds 1 rows');
  });
});

// ---------------------------------------------------------------------------
// FINAL REVIEW M3 — the durable pagination was wired but unreachable: nothing
// attached the buttons or the Page x/y footer to a published message.
// ---------------------------------------------------------------------------
describe('editIntelMessage', () => {
  function fakeClient(edit: ReturnType<typeof vi.fn>): Client {
    const message = { embeds: [], edit };
    const channel = {
      isTextBased: () => true,
      messages: { fetch: vi.fn(async () => message) },
    };
    return { channels: { fetch: vi.fn(async () => channel) } } as unknown as Client;
  }

  it('attaches the navigation row and a Page x/y footer for a multi-page body', async () => {
    const edit = vi.fn(async () => {});
    await editIntelMessage(fakeClient(edit), 'chan', 'msg', 'page one', {
      prefix: 'intelguildpage',
      jobId: 7,
      page: 1,
      totalPages: 3,
    });

    const payload = edit.mock.calls[0][0] as {
      embeds: { footer?: { text: string } }[];
      components: { components: { data: { custom_id: string } }[] }[];
    };
    expect(payload.embeds[0].footer).toEqual({ text: 'Page 1/3' });
    // The ids MUST be exactly what intelPagination's handlers parse:
    // `<prefix>:<jobId>:<page>`.
    const ids = payload.components[0].components.map((c) => c.data.custom_id);
    expect(ids).toEqual(['intelguildpage:7:0', 'intelguildpage:7:2']);
  });

  it('clears any previously attached row and footer for a single-page body', async () => {
    const edit = vi.fn(async () => {});
    await editIntelMessage(fakeClient(edit), 'chan', 'msg', 'only page', {
      prefix: 'intelpage',
      jobId: 7,
      page: 1,
      totalPages: 1,
    });

    const payload = edit.mock.calls[0][0] as {
      embeds: { footer?: unknown }[];
      components: unknown[];
    };
    expect(payload.components).toEqual([]);
    expect(payload.embeds[0].footer).toBeUndefined();
  });

  it('sends no components when no paging metadata is supplied at all', async () => {
    const edit = vi.fn(async () => {});
    await editIntelMessage(fakeClient(edit), 'chan', 'msg', 'logs body');
    const payload = edit.mock.calls[0][0] as { components: unknown[] };
    expect(payload.components).toEqual([]);
  });
});

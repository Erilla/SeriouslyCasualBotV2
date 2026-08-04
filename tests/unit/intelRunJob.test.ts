import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { closeDatabase, getDatabase } from '../../src/database/db.js';
import { createTables } from '../../src/database/schema.js';

vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from '../../src/services/logger.js';
import {
  createJob,
  getJob,
  setMessageIds,
  addFinding,
  getGuildHistory,
} from '../../src/functions/applications/intel/jobStore.js';
import {
  runJob,
  parseUtcTimestamp,
  type RunDeps,
} from '../../src/functions/applications/intel/runJob.js';
import { HttpError } from '../../src/services/httpClient.js';
import { WclPointsExhausted } from '../../src/services/warcraftlogs.js';
import { aggregateGuildHistory } from '../../src/functions/applications/mythic-logs/gatherMythicLogs.js';
import type { MythicKillDate } from '../../src/services/raiderioInternal.js';

const character = { region: 'eu', realm: 'draenor', name: 'Brentpriest' };
const zone = {
  id: 46,
  name: 'VS / DR / MQD',
  expansion: 'Midnight',
  encounters: [
    { id: 1, name: 'A' },
    { id: 2, name: 'B' },
  ],
};

function deps(over: Partial<RunDeps> = {}): RunDeps {
  return {
    editMessage: vi.fn(async () => {}),
    discover: vi.fn(async () => ({ truncated: false })),
    gather: vi.fn(async () => []),
    getZoneCatalogue: vi.fn(async () => [zone]),
    getMythicKillCount: vi.fn(async () => 0),
    getRaidReports: vi.fn(async () => []),
    // Injected so the guild-history loop never touches the real
    // raiderioInternal module (and its real 700ms pace / live HTTP) in a
    // unit test — see CHANGE/finding 3.
    getMythicKillDates: vi.fn(async () => null),
    paceMs: 0,
    tierOrdinals: [35],
    ...over,
  } as RunDeps;
}

describe('runJob', () => {
  let jobId: number;
  beforeEach(() => {
    // Each test now gets a fresh in-memory database (see round 3), so
    // auto-increment ids like jobId restart at 1 every test — the mocked
    // logger.warn's call history must be cleared alongside it, or a later
    // test's job-id-scoped log assertion can match an earlier test's call
    // for the same id.
    vi.clearAllMocks();
    createTables(getDatabase(':memory:'));
    jobId = createJob({ applicationId: 1, targetChannelId: 'chan', character });
    setMessageIds(jobId, { alts: 'ALTS', guilds: 'GUILDS', logs: 'LOGS' });
  });
  afterEach(() => closeDatabase());

  it('completes the job and edits all three messages with real, non-placeholder bodies', async () => {
    const editMessage = vi.fn(async () => {});
    await runJob(jobId, deps({ editMessage }));
    expect(getJob(jobId)?.status).toBe('done');
    const calls = editMessage.mock.calls;
    const edited = calls.map(([, messageId]) => messageId);
    expect(edited).toContain('ALTS');
    expect(edited).toContain('GUILDS');
    expect(edited).toContain('LOGS');
    // A fully successful run must publish the real, data-driven bodies —
    // never the "still working" placeholder text, which is only for a
    // phase that never ran.
    const bodies = calls.map(([, , description]) => description);
    expect(bodies.some((b) => b.includes('searching…'))).toBe(false);
    expect(bodies.some((b) => b.includes('fetching…'))).toBe(false);
  });

  it('pauses on a 429 and records the service and retry time', async () => {
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
    const job = getJob(jobId)!;
    expect(job.status).toBe('paused');
    expect(job.paused_service).toBe('blizzard');
    expect(new Date(job.resume_after!).getTime()).toBeGreaterThan(Date.now());
  });

  // ROUND 2 (supersedes the round-1 version of this test, which skipped
  // editing guilds/logs entirely — the coordinator's own follow-up
  // correction: the real defect was the false BODY, not the footer's
  // absence, and skipping the edit outright reintroduces the stuck-
  // "searching…"-forever failure mode for a pause that's later abandoned
  // without ever revisiting these two messages). A pause during an early
  // phase edits ALL THREE messages, with the rate-limit footer visible on
  // all three so a reviewer can see "retrying shortly" everywhere, but the
  // un-run guilds/logs messages carry their honest placeholder text rather
  // than a data-driven "nothing found" body.
  it('edits all three messages with the rate-limit footer when the alt-source phase pauses', async () => {
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
    const calls = editMessage.mock.calls;
    const alts = calls.find(([, messageId]) => messageId === 'ALTS');
    const guilds = calls.find(([, messageId]) => messageId === 'GUILDS');
    const logs = calls.find(([, messageId]) => messageId === 'LOGS');
    expect(alts?.[2]).toContain('Rate limited on blizzard');
    expect(guilds?.[2]).toContain('Rate limited on blizzard');
    expect(logs?.[2]).toContain('Rate limited on blizzard');
    // The placeholder, not the data-driven "nothing found" renderer output.
    expect(guilds?.[2]).toContain('**Guild history** — searching…');
    expect(logs?.[2]).toContain('**Mythic raid logs** — fetching…');
  });

  // FINDING 2 (pinned exactly as directed): the specific violation is an
  // affirmative EMPTY body ("no logs found") standing in for "never measured".
  it('a pause during the alt phase does not publish an affirmative empty logs body', async () => {
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
    const bodies = editMessage.mock.calls.map(([, , description]) => description);
    expect(bodies.some((b) => b.includes('No Mythic raid logs found'))).toBe(false);
    expect(bodies.some((b) => b.includes('No guild history found'))).toBe(false);
  });

  it('does not pause on a non-rate-limit error, and still finishes', async () => {
    await runJob(
      jobId,
      deps({
        gather: vi.fn(async () => {
          throw new Error('boom');
        }),
      }),
    );
    expect(getJob(jobId)?.status).toBe('done');
  });

  // ROUND 2 (new breakage found in round 1's fix): the degrade-and-finish
  // path is terminal — status becomes 'done' and nothing ever retries — so
  // it must still publish all three messages. Skipping an un-run phase's
  // edit here (round 1's mistake) would freeze it on "searching…" forever.
  it('the degrade-and-finish path edits all three messages, with placeholders (not false negatives) for phases that never ran', async () => {
    const editMessage = vi.fn(async () => {});
    await runJob(
      jobId,
      deps({
        editMessage,
        discover: vi.fn(async () => {
          throw new Error('boom');
        }),
      }),
    );
    expect(getJob(jobId)?.status).toBe('done');
    const calls = editMessage.mock.calls;
    const alts = calls.find(([, messageId]) => messageId === 'ALTS');
    const guilds = calls.find(([, messageId]) => messageId === 'GUILDS');
    const logs = calls.find(([, messageId]) => messageId === 'LOGS');
    expect(alts).toBeDefined();
    expect(guilds).toBeDefined();
    expect(logs).toBeDefined();
    expect(guilds?.[2]).toContain('**Guild history** — searching…');
    expect(guilds?.[2]).not.toContain('No guild history found');
    expect(logs?.[2]).toContain('**Mythic raid logs** — fetching…');
    expect(logs?.[2]).not.toContain('No Mythic raid logs found');
    // Terminal and un-run, with no rate-limit footer of its own: a short
    // factual note stands in so the message never reads as still working.
    expect(guilds?.[2]).toContain('Incomplete');
    expect(logs?.[2]).toContain('Incomplete');
  });

  it('abandons the job past the attempt cap and says so in the messages', async () => {
    getDatabase().prepare('UPDATE applicant_intel_jobs SET attempts = 20 WHERE id = ?').run(jobId);
    addFinding(jobId, {
      name: 'Brentpriest',
      realm: 'Draenor',
      className: 'Priest',
      guildName: null,
      guildRealm: null,
      source: 'application',
      confidence: null,
      discordStatus: null,
      discordProfile: null,
    });

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
          });
        }),
      }),
    );

    expect(getJob(jobId)?.status).toBe('failed');
    const bodies = editMessage.mock.calls.map(([, , description]) => description);
    expect(bodies.some((b) => b.includes('Incomplete'))).toBe(true);
  });

  it('marks the job running while it works', async () => {
    let observed: string | undefined;
    await runJob(
      jobId,
      deps({
        discover: vi.fn(async () => {
          observed = getJob(jobId)?.status;
          return { truncated: false };
        }),
      }),
    );
    expect(observed).toBe('running');
  });

  // CHANGE 1 (from Task 15's brief-mandated changes): WclPointsExhausted
  // must pause the job on the warcraftlogs service, not fall through to
  // "degrade and finish".
  it('pauses on WclPointsExhausted with the warcraftlogs service, not done', async () => {
    await runJob(
      jobId,
      deps({
        gather: vi.fn(async () => {
          throw new WclPointsExhausted(9500, 10000);
        }),
      }),
    );
    const job = getJob(jobId)!;
    expect(job.status).toBe('paused');
    expect(job.paused_service).toBe('warcraftlogs');
    expect(job.resume_after).not.toBeNull();
    expect(new Date(job.resume_after!).getTime()).toBeGreaterThan(Date.now());
  });

  it('also pauses on WclPointsExhausted thrown from discover', async () => {
    await runJob(
      jobId,
      deps({
        discover: vi.fn(async () => {
          throw new WclPointsExhausted(9500, 10000);
        }),
      }),
    );
    const job = getJob(jobId)!;
    expect(job.status).toBe('paused');
    expect(job.paused_service).toBe('warcraftlogs');
  });

  // CHANGE 3 / FINDING 3: the aggregated guild history is persisted from
  // controlled kill-date data injected via RunDeps, proving both that the
  // computation happens against test-controlled data (not the real,
  // network-touching raiderioInternal module) and that the persisted
  // payload matches what aggregateGuildHistory actually produces from it.
  it('persists the aggregated guild history computed from injected kill-date data', async () => {
    const killDate: MythicKillDate = {
      bossName: 'A',
      firstDefeated: '2026-01-01T00:00:00.000Z',
      guild: { name: 'Test Guild', realm: 'Draenor' },
    };
    const getMythicKillDates = vi.fn(async () => [killDate]);
    await runJob(jobId, deps({ getMythicKillDates }));

    const expected = aggregateGuildHistory(
      [{ character: character.name, entries: [killDate] }],
      [zone],
    );
    expect(getGuildHistory(jobId)).toEqual(expected);
  });

  it('replaces a previously persisted guild history rather than keeping the first write', async () => {
    const killDate: MythicKillDate = {
      bossName: 'A',
      firstDefeated: '2026-01-01T00:00:00.000Z',
      guild: { name: 'Old Guild', realm: 'Draenor' },
    };
    await runJob(jobId, deps({ getMythicKillDates: vi.fn(async () => [killDate]) }));
    expect(getGuildHistory(jobId)).not.toEqual([]);

    // A second attempt (e.g. after a resume) computes an empty history — the
    // most likely outcome of a swallowed 429 — and it must overwrite, not be
    // silently dropped by ON CONFLICT DO NOTHING.
    await runJob(jobId, deps({ getMythicKillDates: vi.fn(async () => []) }));
    expect(getGuildHistory(jobId)).toEqual([]);
  });

  // FINDING 1: a rejected editMessage for one placeholder must not block the
  // other two, and must not escape runJob (which would otherwise leave the
  // job "done" with the remaining placeholders stuck on "searching…"
  // forever, since nothing will ever retry a done job).
  it('a failing ALTS edit still edits guilds and logs, and does not throw out of runJob', async () => {
    const editMessage = vi.fn(async (_channelId: string, messageId: string) => {
      if (messageId === 'ALTS') throw new Error('Unknown Message');
    });
    await expect(runJob(jobId, deps({ editMessage }))).resolves.toBeUndefined();
    expect(getJob(jobId)?.status).toBe('done');
    const edited = editMessage.mock.calls.map(([, messageId]) => messageId);
    expect(edited).toContain('GUILDS');
    expect(edited).toContain('LOGS');
  });

  // FINDING 4: the failure log must name the phase that actually ran, not
  // job.phase's in-memory snapshot from before the run started (which
  // defaults to 'logs' — the one phase that certainly didn't run if
  // discover fails first).
  it('logs the phase that actually failed, not a stale snapshot', async () => {
    await runJob(
      jobId,
      deps({
        discover: vi.fn(async () => {
          throw new Error('boom');
        }),
      }),
    );
    const warnCalls = (logger.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    // logger.warn's call history accumulates across every test in this file
    // (nothing resets the mock), so the match must be scoped to this test's
    // own job id, not just the first "failed in phase" call ever recorded.
    const failureLog = warnCalls.find(
      ([, msg]) =>
        typeof msg === 'string' &&
        msg.includes(`Job #${jobId} failed in phase`) &&
        msg.includes('boom'),
    );
    expect(failureLog?.[1]).toContain('alt_sources');
    expect(failureLog?.[1]).not.toContain('phase logs');
  });

  // FINDING 5: created_at is a SQLite `datetime('now')` UTC string with no
  // zone marker; naive `new Date(...)` parses it as local time. On a
  // machine ahead of UTC (e.g. BST, UTC+1) that reads created_at as having
  // happened EARLIER than it did, inflating the computed age. Pin the
  // boundary just inside the correct 7-day window so a local-time parse
  // (which would push the age just past it) wrongly abandons instead of
  // pausing.
  it('computes job age against the UTC clock, not local wall-clock time', async () => {
    getDatabase()
      .prepare('UPDATE applicant_intel_jobs SET created_at = ? WHERE id = ?')
      .run('2026-07-01 00:00:00', jobId);
    const now = () => new Date('2026-07-07T23:30:00.000Z');

    await runJob(
      jobId,
      deps({
        now,
        discover: vi.fn(async () => {
          throw new HttpError({
            service: 'blizzard',
            status: 429,
            attempts: 1,
            message: 'rate limited',
          });
        }),
      }),
    );

    expect(getJob(jobId)?.status).toBe('paused');
  });

  // ROUND 2: the behavioural test above only fails pre-fix on a host with a
  // non-zero UTC offset (it happens to catch the bug here because this
  // machine is on BST in July); on a permanently-UTC CI box it would pass
  // either way and guard nothing. Test the parsing primitive directly so
  // the assertion is deterministic on every host.
  it('parseUtcTimestamp parses a SQLite datetime string as UTC regardless of host timezone', () => {
    const parsed = parseUtcTimestamp('2026-07-01 12:34:56');
    expect(parsed.getTime()).toBe(Date.UTC(2026, 6, 1, 12, 34, 56));
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { closeDatabase, getDatabase } from '../../src/database/db.js';
import { createTables } from '../../src/database/schema.js';

vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  createJob,
  getJob,
  pauseJob,
  dueJobs,
  resetRunningJobs,
  setStatus,
  setMessageIds,
  setApplicantCharacters,
  getApplicantCharacters,
  enqueue,
  pendingQueue,
  markQueueDone,
  markScanned,
  isScanned,
  scannedCount,
  addFinding,
  getFindings,
  setGuildHistory,
  getGuildHistory,
} from '../../src/functions/applications/intel/jobStore.js';
import type { GuildHistoryEntry } from '../../src/functions/applications/intel/render.js';

const character = { region: 'eu', realm: 'draenor', name: 'Brentpriest' };

describe('intel job store', () => {
  beforeEach(() => {
    createTables(getDatabase(':memory:'));
  });
  afterEach(() => closeDatabase());

  it('creates a job in the pending/logs state', () => {
    const id = createJob({ applicationId: 7, targetChannelId: '123', character });
    const job = getJob(id);
    expect(job?.status).toBe('pending');
    expect(job?.phase).toBe('logs');
    expect(job?.application_id).toBe(7);
    expect(job?.target_channel_id).toBe('123');
    expect(job?.character_name).toBe('Brentpriest');
  });

  it('stores the applicant Discord handle when given', () => {
    const id = createJob({
      applicationId: 1,
      targetChannelId: '1',
      character,
      applicantDiscord: 'binded',
    });
    expect(getJob(id)?.applicant_discord).toBe('binded');
  });

  it('leaves the Discord handle null when not given', () => {
    const id = createJob({ applicationId: 1, targetChannelId: '1', character });
    expect(getJob(id)?.applicant_discord).toBeNull();
  });

  it('allows a null application_id for ad-hoc /test runs', () => {
    const id = createJob({ applicationId: null, targetChannelId: '999', character });
    expect(getJob(id)?.application_id).toBeNull();
  });

  it('pauses with a resume time, a service and an incremented attempt count', () => {
    const id = createJob({ applicationId: 1, targetChannelId: '1', character });
    pauseJob(id, 'blizzard', 60_000);
    const job = getJob(id)!;
    expect(job.status).toBe('paused');
    expect(job.paused_service).toBe('blizzard');
    expect(job.attempts).toBe(1);
    expect(new Date(job.resume_after!).getTime()).toBeGreaterThan(Date.now());
  });

  it('returns only jobs whose resume time has passed', () => {
    const past = createJob({ applicationId: 1, targetChannelId: '1', character });
    pauseJob(past, 'blizzard', -1000);
    const future = createJob({ applicationId: 2, targetChannelId: '1', character });
    pauseJob(future, 'blizzard', 600_000);

    const due = dueJobs(new Date().toISOString()).map((j) => j.id);
    expect(due).toContain(past);
    expect(due).not.toContain(future);
  });

  it('includes pending jobs in dueJobs', () => {
    const id = createJob({ applicationId: 1, targetChannelId: '1', character });
    expect(dueJobs(new Date().toISOString()).map((j) => j.id)).toContain(id);
  });

  it('resets running jobs to pending for crash recovery', () => {
    const id = createJob({ applicationId: 1, targetChannelId: '1', character });
    setStatus(id, 'running');
    expect(resetRunningJobs()).toBe(1);
    expect(getJob(id)?.status).toBe('pending');
  });

  it('stores all three message ids independently', () => {
    const id = createJob({ applicationId: 1, targetChannelId: '1', character });
    setMessageIds(id, { alts: 'A' });
    setMessageIds(id, { guilds: 'G' });
    setMessageIds(id, { logs: 'L' });
    const job = getJob(id)!;
    expect(job.alts_message_id).toBe('A');
    expect(job.guilds_message_id).toBe('G');
    expect(job.logs_message_id).toBe('L');
  });

  it('round-trips every character the applicant named', () => {
    const id = createJob({ applicationId: 1, targetChannelId: '1', character });
    setApplicantCharacters(id, [
      character,
      { region: 'eu', realm: 'draenor', name: 'Brenthunter' },
    ]);
    expect(getApplicantCharacters(id).map((c) => c.name)).toEqual(['Brentpriest', 'Brenthunter']);
  });

  it('tracks queue items and marks them done', () => {
    const id = createJob({ applicationId: 1, targetChannelId: '1', character });
    enqueue(id, 'guild', 'Rancour-draenor', { depth: 0 });
    enqueue(id, 'guild', 'Rancour-draenor', { depth: 0 });
    expect(pendingQueue(id, 'guild')).toEqual([{ key: 'Rancour-draenor', payload: { depth: 0 } }]);
    markQueueDone(id, 'guild', 'Rancour-draenor');
    expect(pendingQueue(id, 'guild')).toEqual([]);
  });

  it('records scanned characters idempotently', () => {
    const id = createJob({ applicationId: 1, targetChannelId: '1', character });
    markScanned(id, 'Gorre-Outland');
    markScanned(id, 'gorre-outland');
    expect(isScanned(id, 'gorre-outland')).toBe(true);
    expect(isScanned(id, 'someone-else')).toBe(false);
    expect(scannedCount(id)).toBe(1);
  });

  it('keeps the strongest source when the same character is found twice', () => {
    const id = createJob({ applicationId: 1, targetChannelId: '1', character });
    const base = {
      name: 'Gorre',
      realm: 'Outland',
      className: 'Death Knight',
      guildName: 'Goodlife',
      guildRealm: 'Tarren Mill',
      discordStatus: null,
      discordProfile: null,
    };
    addFinding(id, { ...base, source: 'fingerprint', confidence: 83 });
    addFinding(id, { ...base, source: 'raider.io', confidence: 100 });
    addFinding(id, { ...base, source: 'fingerprint', confidence: 83 });

    const found = getFindings(id);
    expect(found).toHaveLength(1);
    expect(found[0].source).toBe('raider.io');
    expect(found[0].confidence).toBe(100);
  });

  /**
   * The back-link (this character names the applicant as its main) is a
   * self-asserted fact from the same account, so it must upgrade a fingerprint
   * guess — the whole reason the confirmation pass records it at all.
   */
  it('upgrades a fingerprint finding when the character declares the applicant as its main', () => {
    const id = createJob({ applicationId: 1, targetChannelId: '1', character });
    const base = {
      name: 'Dragonii',
      realm: 'aggra-português',
      className: 'Evoker',
      guildName: 'Killing Pixels',
      guildRealm: 'draenor',
      discordStatus: null,
      discordProfile: null,
    };
    addFinding(id, { ...base, source: 'fingerprint', confidence: 79 });
    addFinding(id, { ...base, source: 'declared alt', confidence: 100 });

    const found = getFindings(id);
    expect(found).toHaveLength(1);
    expect(found[0].source).toBe('declared alt');
    expect(found[0].confidence).toBe(100);
  });

  /** Nothing outranks a character the applicant named themselves. */
  it('does not let a back-link downgrade an application character', () => {
    const id = createJob({ applicationId: 1, targetChannelId: '1', character });
    const base = {
      name: 'Xplendor',
      realm: 'aggra-português',
      className: 'Hunter',
      guildName: 'Aeterna',
      guildRealm: 'silvermoon',
      discordStatus: null,
      discordProfile: null,
    };
    addFinding(id, { ...base, source: 'application', confidence: null });
    addFinding(id, { ...base, source: 'declared alt', confidence: 100 });

    expect(getFindings(id)[0].source).toBe('application');
  });

  it('returns an empty guild history for a job with none persisted', () => {
    const id = createJob({ applicationId: 1, targetChannelId: '1', character });
    expect(getGuildHistory(id)).toEqual([]);
  });

  it('replaces a previously persisted guild history rather than keeping the first write', () => {
    const id = createJob({ applicationId: 1, targetChannelId: '1', character });
    const first: GuildHistoryEntry[] = [
      { guildName: 'Rancour', guildRealm: 'Draenor', stints: [] },
    ];
    const second: GuildHistoryEntry[] = [];

    setGuildHistory(id, first);
    expect(getGuildHistory(id)).toEqual(first);

    setGuildHistory(id, second);
    expect(getGuildHistory(id)).toEqual(second);
  });
});

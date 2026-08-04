import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { closeDatabase, getDatabase } from '../../src/database/db.js';
import { createTables } from '../../src/database/schema.js';

vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  createJob,
  addFinding,
  setGuildHistory,
} from '../../src/functions/applications/intel/jobStore.js';
import { buildIntelPage, buildGuildHistoryPage } from '../../src/interactions/intelPagination.js';
import type { GuildHistoryEntry } from '../../src/functions/applications/intel/render.js';

const character = { region: 'eu', realm: 'draenor', name: 'Regnipaw' };

describe('buildIntelPage', () => {
  let jobId: number;
  beforeEach(() => {
    createTables(getDatabase(':memory:'));
    jobId = createJob({ applicationId: 1, targetChannelId: 'c', character });
    for (let i = 0; i < 80; i++) {
      addFinding(jobId, {
        name: `Alt${i}`,
        realm: 'Draenor',
        className: 'Monk',
        guildName: 'Rancour',
        guildRealm: 'Draenor',
        source: 'fingerprint',
        confidence: 50,
        discordStatus: null,
        discordProfile: null,
      });
    }
  });
  afterEach(() => closeDatabase());

  it('rebuilds a page from the database, not a cache', () => {
    const page = buildIntelPage(jobId, 2, 'Regnipaw', 'eu')!;
    expect(page.page).toBe(2);
    expect(page.totalPages).toBeGreaterThan(1);
    expect(page.description.length).toBeGreaterThan(0);
  });

  it('returns null for a page out of range', () => {
    expect(buildIntelPage(jobId, 99, 'Regnipaw', 'eu')).toBeNull();
  });

  it('returns null for an unknown job', () => {
    expect(buildIntelPage(999_999, 1, 'Regnipaw', 'eu')).toBeNull();
  });
});

// ADDITION: the guild-history embed pages the same way, but from
// setGuildHistory/getGuildHistory (Task 18's fix for enqueue's
// ON-CONFLICT-DO-NOTHING) rather than from applicant_intel_findings.
describe('buildGuildHistoryPage', () => {
  let jobId: number;
  beforeEach(() => {
    createTables(getDatabase(':memory:'));
    jobId = createJob({ applicationId: 1, targetChannelId: 'c', character });
  });
  afterEach(() => closeDatabase());

  function bigHistory(): GuildHistoryEntry[] {
    const entries: GuildHistoryEntry[] = [];
    for (let i = 0; i < 40; i++) {
      entries.push({
        guildName: `Guild${i}`,
        guildRealm: 'Draenor',
        stints: [
          {
            raidName: 'VS / DR / MQD',
            kills: 5,
            first: '2026-01-01T00:00:00.000Z',
            last: '2026-01-05T00:00:00.000Z',
            characters: ['Regnipaw'],
          },
        ],
      });
    }
    return entries;
  }

  it('rebuilds a page from the database, not a cache', () => {
    setGuildHistory(jobId, bigHistory());
    const page = buildGuildHistoryPage(jobId, 2, 'eu')!;
    expect(page.page).toBe(2);
    expect(page.totalPages).toBeGreaterThan(1);
    expect(page.description.length).toBeGreaterThan(0);
  });

  it('reflects the most recently persisted history, not a stale first write', () => {
    setGuildHistory(jobId, bigHistory());
    setGuildHistory(jobId, []);
    // Only one page exists now — the empty-state page.
    expect(buildGuildHistoryPage(jobId, 1, 'eu')?.description).toContain('No guild history found');
    expect(buildGuildHistoryPage(jobId, 2, 'eu')).toBeNull();
  });

  it('returns null for a page out of range', () => {
    setGuildHistory(jobId, bigHistory());
    expect(buildGuildHistoryPage(jobId, 99, 'eu')).toBeNull();
  });

  it('returns null for an unknown job', () => {
    expect(buildGuildHistoryPage(999_999, 1, 'eu')).toBeNull();
  });
});

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
  setSweepTruncated,
} from '../../src/functions/applications/intel/jobStore.js';
import {
  buildIntelPage,
  buildGuildHistoryPage,
  buttons,
} from '../../src/interactions/intelPagination.js';
import type { GuildHistoryEntry } from '../../src/functions/applications/intel/render.js';
import type { ButtonInteraction } from 'discord.js';

function mockInteraction() {
  return {
    reply: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
  } as unknown as ButtonInteraction;
}

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

  // FIX ROUND 1: `NaN < 0` and `NaN >= pages.length` are both false, so a
  // non-numeric page (a malformed customId) must be rejected explicitly
  // rather than falling through the bounds check.
  it('returns null for a NaN page', () => {
    expect(buildIntelPage(jobId, NaN, 'Regnipaw', 'eu')).toBeNull();
  });

  // RE-REVIEW ITEM 2: M4's "search incomplete" note only existed in the message
  // runJob published; M3 then made the Next/Previous buttons work for the first
  // time, and paging back to page 1 rebuilds from the database — silently
  // dropping the note and turning an incomplete sweep into a complete-looking
  // one. It is now derived from the persisted sweep verdict.
  it('keeps the truncation note on page 1 when the sweep was incomplete', () => {
    setSweepTruncated(jobId, true);
    expect(buildIntelPage(jobId, 1, 'Regnipaw', 'eu')?.description).toContain('Search incomplete');
  });

  it('does not put the truncation note on later pages', () => {
    setSweepTruncated(jobId, true);
    expect(buildIntelPage(jobId, 2, 'Regnipaw', 'eu')?.description).not.toContain(
      'Search incomplete',
    );
  });

  it('omits the truncation note when the sweep was complete', () => {
    setSweepTruncated(jobId, false);
    expect(buildIntelPage(jobId, 1, 'Regnipaw', 'eu')?.description).not.toContain(
      'Search incomplete',
    );
  });

  it('omits the truncation note when nothing was ever recorded about the sweep', () => {
    expect(buildIntelPage(jobId, 1, 'Regnipaw', 'eu')?.description).not.toContain(
      'Search incomplete',
    );
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

  // FIX ROUND 1: same NaN-bypasses-the-bounds-check hazard as buildIntelPage.
  it('returns null for a NaN page', () => {
    setGuildHistory(jobId, bigHistory());
    expect(buildGuildHistoryPage(jobId, NaN, 'eu')).toBeNull();
  });
});

// FIX ROUND 1: a malformed customId (missing/non-numeric page or job segment)
// must produce the handler's specific ephemeral reply, not throw out of
// EmbedBuilder.setDescription(undefined) into the generic error middleware.
describe('intelPagination button handlers with malformed params', () => {
  let jobId: number;
  beforeEach(() => {
    createTables(getDatabase(':memory:'));
    jobId = createJob({ applicationId: 1, targetChannelId: 'c', character });
    addFinding(jobId, {
      name: 'Alt0',
      realm: 'Draenor',
      className: 'Monk',
      guildName: 'Rancour',
      guildRealm: 'Draenor',
      source: 'fingerprint',
      confidence: 50,
      discordStatus: null,
      discordProfile: null,
    });
    setGuildHistory(jobId, [
      {
        guildName: 'Rancour',
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
      },
    ]);
  });
  afterEach(() => closeDatabase());

  function getHandler(prefix: string) {
    const handler = buttons.find((b) => b.prefix === prefix);
    if (!handler) throw new Error(`${prefix} handler not registered`);
    return handler.handle;
  }

  it('intelpage replies with the specific message when the page segment is missing', async () => {
    const interaction = mockInteraction();
    await getHandler('intelpage')(interaction, [String(jobId)]); // no page segment -> NaN

    expect(interaction.reply).toHaveBeenCalledWith({
      content: 'That character list is no longer available.',
      flags: expect.anything(),
    });
    expect(interaction.update).not.toHaveBeenCalled();
  });

  it('intelpage replies with the specific message when the job segment is non-numeric', async () => {
    const interaction = mockInteraction();
    await getHandler('intelpage')(interaction, ['not-a-number', '1']);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: 'That character list is no longer available.',
      flags: expect.anything(),
    });
  });

  it('intelguildpage replies with the specific message when the page segment is missing', async () => {
    const interaction = mockInteraction();
    await getHandler('intelguildpage')(interaction, [String(jobId)]); // no page segment -> NaN

    expect(interaction.reply).toHaveBeenCalledWith({
      content: 'That guild history is no longer available.',
      flags: expect.anything(),
    });
    expect(interaction.update).not.toHaveBeenCalled();
  });

  it('intelguildpage replies with the specific message when the job segment is non-numeric', async () => {
    const interaction = mockInteraction();
    await getHandler('intelguildpage')(interaction, ['not-a-number', '1']);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: 'That guild history is no longer available.',
      flags: expect.anything(),
    });
  });
});

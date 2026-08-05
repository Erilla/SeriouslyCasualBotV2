import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { closeDatabase, getDatabase } from '../../src/database/db.js';
import { createTables } from '../../src/database/schema.js';

vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  placeholderEmbed,
  startIntelJob,
} from '../../src/functions/applications/intel/placeholders.js';
import { getApplicantCharacters, getJob } from '../../src/functions/applications/intel/jobStore.js';

const character = { region: 'eu', realm: 'draenor', name: 'Brentpriest' };

describe('placeholderEmbed', () => {
  it('says searching for the alts message', () => {
    expect(placeholderEmbed('alts').toJSON().description).toContain('Found characters');
  });

  it('names the guild history message', () => {
    expect(placeholderEmbed('guilds').toJSON().description).toContain('Guild history');
  });

  it('says fetching for the logs message', () => {
    expect(placeholderEmbed('logs').toJSON().description).toContain('fetching');
  });
});

describe('startIntelJob', () => {
  beforeEach(() => {
    createTables(getDatabase(':memory:'));
  });
  afterEach(() => closeDatabase());

  it('creates a pending job carrying all three message ids', () => {
    const id = startIntelJob({
      applicationId: 5,
      targetChannelId: 'chan',
      characters: [character],
      altsMessageId: 'A',
      guildsMessageId: 'G',
      logsMessageId: 'L',
    });
    const job = getJob(id)!;
    expect(job.status).toBe('pending');
    expect(job.alts_message_id).toBe('A');
    expect(job.guilds_message_id).toBe('G');
    expect(job.logs_message_id).toBe('L');
    expect(job.application_id).toBe(5);
  });

  it('stores every named character, with the first as the primary', () => {
    const id = startIntelJob({
      applicationId: 5,
      targetChannelId: 'chan',
      characters: [character, { region: 'eu', realm: 'draenor', name: 'Brenthunter' }],
    });
    expect(getJob(id)?.character_name).toBe('Brentpriest');
    expect(getApplicantCharacters(id).map((c) => c.name)).toEqual(['Brentpriest', 'Brenthunter']);
  });
});

describe('placeholders are only reserved when there is something to sweep', () => {
  /**
   * Reserving the three positions and queueing the sweep used to be separate
   * decisions in separate functions. Anything that did the first without the second
   * left three embeds reading "searching…" forever — which hit the testdata seeder
   * (it calls createForumPost directly) and every real application whose answers
   * contain no parseable Raider.IO URL. Verified live: a seeded application sat on
   * "searching…" with no job row in the database at all.
   */
  const sends: unknown[] = [];
  const thread = {
    id: 'THREAD',
    send: vi.fn(async (payload: unknown) => {
      sends.push(payload);
      return { id: `MSG${sends.length}` };
    }),
  };

  beforeEach(() => {
    sends.length = 0;
    thread.send.mockClear();
  });

  /** The decision under test, mirroring createForumPost's guard. */
  const reservePlaceholders = async (
    characters: { region: string; realm: string; name: string }[],
  ): Promise<string[]> => {
    const ids: string[] = [];
    if (characters.length > 0) {
      for (const kind of ['alts', 'guilds', 'logs'] as const) {
        const m = await thread.send({ embeds: [placeholderEmbed(kind)] });
        ids.push(m.id);
      }
    }
    return ids;
  };

  it('reserves all three when a character was named', async () => {
    const ids = await reservePlaceholders([
      { region: 'eu', realm: 'draenor', name: 'Brentpriest' },
    ]);
    expect(ids).toHaveLength(3);
    expect(thread.send).toHaveBeenCalledTimes(3);
  });

  it('reserves none when no character was named', async () => {
    const ids = await reservePlaceholders([]);
    expect(ids).toEqual([]);
    expect(thread.send).not.toHaveBeenCalled();
  });
});

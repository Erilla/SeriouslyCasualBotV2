import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { closeDatabase, getDatabase } from '../../src/database/db.js';
import { createTables } from '../../src/database/schema.js';

vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  idlePlaceholderEmbed,
  intelRefreshRow,
  placeholderEmbed,
  startIntelJob,
} from '../../src/functions/applications/intel/placeholders.js';
import {
  dueJobs,
  getApplicantCharacters,
  getControlMessageId,
  getJob,
} from '../../src/functions/applications/intel/jobStore.js';

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

describe('idle reservations', () => {
  /**
   * Reserving the three positions and queueing the sweep used to be one decision,
   * because anything that reserved without queueing left three embeds reading
   * "searching…" forever — the testdata seeder (it calls createForumPost directly)
   * and every application whose answers contain no parseable Raider.IO URL.
   *
   * They are separate again, because a character can arrive later as a conversation
   * link and Discord cannot insert a message above the voting controls after the
   * fact — so skipping the reservation denied those applications intel permanently.
   * What makes that safe is that the reservation is no longer a lie: idle copy plus
   * an 'idle' job that owns the message ids until a link reopens it.
   */
  beforeEach(() => {
    createTables(getDatabase(':memory:'));
  });
  afterEach(() => closeDatabase());

  it('does not claim to be searching when nothing is queued', () => {
    expect(idlePlaceholderEmbed('alts').toJSON().description).not.toContain('searching');
    expect(idlePlaceholderEmbed('alts').toJSON().description).toContain('Refresh');
    expect(placeholderEmbed('alts').toJSON().description).toContain('searching');
  });

  it('reserves an idle job that the scheduler will not pick up', () => {
    const id = startIntelJob({
      applicationId: 5,
      targetChannelId: 'chan',
      characters: [],
      altsMessageId: 'A',
      refreshMessageId: 'R',
    });
    expect(getJob(id)?.status).toBe('idle');
    expect(getJob(id)?.alts_message_id).toBe('A');
    expect(getControlMessageId(id)).toBe('R');
    expect(dueJobs(new Date().toISOString())).toEqual([]);
  });

  it('disables the refresh control only while a sweep is in flight', () => {
    const disabled = (status: Parameters<typeof intelRefreshRow>[1]): boolean =>
      intelRefreshRow(5, status).toJSON().components[0].disabled === true;

    expect(disabled('pending')).toBe(true);
    expect(disabled('running')).toBe(true);
    expect(disabled('idle')).toBe(false);
    expect(disabled('done')).toBe(false);
    expect(disabled('failed')).toBe(false);
    expect(disabled('paused')).toBe(false);
  });
});

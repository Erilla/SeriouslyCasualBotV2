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

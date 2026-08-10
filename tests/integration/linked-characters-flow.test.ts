import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Guild } from 'discord.js';
import { initDatabase, closeDatabase, getDatabase } from '../../src/database/db.js';

const { mockedResolveCharacterLinks } = vi.hoisted(() => ({
  mockedResolveCharacterLinks: vi.fn(),
}));

vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// The only boundary stubbed: resolution is three live APIs (Blizzard's realm
// index, WarcraftLogs and Raider.IO). Everything between the pasted URL and the
// scheduler's view of the job is the real code.
vi.mock('../../src/functions/applications/resolveCharacterLinks.js', () => ({
  resolveCharacterLinks: mockedResolveCharacterLinks,
}));

const { refreshLinkedCharacters } =
  await import('../../src/functions/applications/refreshLinkedCharacters.js');
const { startIntelJob } = await import('../../src/functions/applications/intel/placeholders.js');
const {
  dueJobs,
  getControlMessageId,
  getJobByApplication,
  getLinkedCharacters,
  setStatus,
  topUpRequested,
} = await import('../../src/functions/applications/intel/jobStore.js');
const event = (await import('../../src/events/messageCreate.js')).default;

const RIO = (name: string): string => `https://raider.io/characters/eu/draenor/${name}`;

/** A guild whose application channel holds exactly the given message contents. */
function guildWith(contents: string[]): Guild {
  return {
    channels: {
      fetch: vi.fn(async (id: string) => {
        if (id !== 'CHAN') return null;
        return {
          id,
          isTextBased: () => true,
          messages: {
            fetch: vi.fn(async () => ({
              size: contents.length,
              values: () => contents.map((content, i) => ({ id: `m${i}`, content })).values(),
              last: () => ({ id: `m${contents.length - 1}` }),
            })),
          },
        };
      }),
    },
  } as unknown as Guild;
}

describe('linked character intel flow (integration)', () => {
  beforeEach(() => {
    closeDatabase();
    initDatabase(':memory:');
    mockedResolveCharacterLinks.mockReset();
    getDatabase()
      .prepare(
        `INSERT INTO applications (id, character_name, applicant_user_id, status, channel_id, thread_id)
         VALUES (4, 'Brentpriest', 'u1', 'active', 'CHAN', 'THREAD')`,
      )
      .run();
  });

  afterEach(() => closeDatabase());

  it('carries an application that named nobody all the way to a queued sweep', async () => {
    // Submission reserved three positions and a Refresh control, but the answers
    // held no parseable character, so the job exists only to own those ids.
    const jobId = startIntelJob({
      applicationId: 4,
      targetChannelId: 'THREAD',
      characters: [],
      altsMessageId: 'A',
      guildsMessageId: 'G',
      logsMessageId: 'L',
      refreshMessageId: 'R',
    });

    expect(getJobByApplication(4)).toMatchObject({ id: jobId, status: 'idle', character_name: '' });
    expect(getControlMessageId(jobId)).toBe('R');
    expect(dueJobs(new Date().toISOString())).toEqual([]);

    // An officer presses Refresh after the applicant pasted their Raider.IO URL.
    mockedResolveCharacterLinks.mockResolvedValue({
      identities: [{ region: 'eu', realm: 'draenor', name: 'Brentpriest' }],
      statuses: [],
    });

    const refreshed = await refreshLinkedCharacters(4, guildWith([RIO('Brentpriest')]));
    expect(refreshed).toMatchObject({ outcome: 'ok', queued: ['Brentpriest'] });

    // Still exactly one job for the application, now due and rooted on a primary.
    expect(
      getDatabase()
        .prepare('SELECT COUNT(*) AS n FROM applicant_intel_jobs WHERE application_id = 4')
        .get(),
    ).toEqual({ n: 1 });
    expect(getJobByApplication(4)).toMatchObject({
      id: jobId,
      status: 'pending',
      character_name: 'Brentpriest',
      alts_message_id: 'A',
    });
    expect(getLinkedCharacters(jobId).map((c) => c.name)).toEqual(['Brentpriest']);
    expect(dueJobs(new Date().toISOString()).map((job) => job.id)).toEqual([jobId]);

    // A second link arrives while the sweep is mid-flight. It must register
    // against the running job without interrupting it.
    setStatus(jobId, 'running');
    mockedResolveCharacterLinks.mockResolvedValue({
      identities: [{ region: 'eu', realm: 'draenor', name: 'Brenthunter' }],
      statuses: [],
    });

    await event.execute({
      content: RIO('Brenthunter'),
      channelId: 'CHAN',
      author: { bot: false },
      guild: { id: 'G' },
    } as never);

    expect(getLinkedCharacters(jobId).map((c) => c.name)).toEqual(['Brentpriest', 'Brenthunter']);
    expect(getJobByApplication(4)?.status).toBe('running');
    expect(topUpRequested(jobId)).toBe(true);

    // The primary was chosen once and the append must not have re-rooted it.
    expect(getJobByApplication(4)?.character_name).toBe('Brentpriest');
  });

  it('leaves a done job pending again when a link lands after it finished', async () => {
    const jobId = startIntelJob({
      applicationId: 4,
      targetChannelId: 'THREAD',
      characters: [{ region: 'eu', realm: 'draenor', name: 'Brentpriest' }],
    });
    setStatus(jobId, 'done');

    mockedResolveCharacterLinks.mockResolvedValue({
      identities: [{ region: 'eu', realm: 'draenor', name: 'Brenthunter' }],
      statuses: [],
    });

    await event.execute({
      content: RIO('Brenthunter'),
      channelId: 'THREAD',
      author: { bot: false },
      guild: { id: 'G' },
    } as never);

    // Reopened rather than left done, so the scheduler will pick it back up.
    expect(getJobByApplication(4)?.status).toBe('pending');
    expect(dueJobs(new Date().toISOString()).map((job) => job.id)).toEqual([jobId]);
  });
});

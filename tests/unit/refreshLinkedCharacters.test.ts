import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Guild } from 'discord.js';
import { closeDatabase, getDatabase } from '../../src/database/db.js';
import { createTables } from '../../src/database/schema.js';

const { mockedResolveCharacterLinks } = vi.hoisted(() => ({
  mockedResolveCharacterLinks: vi.fn(),
}));

vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/functions/applications/resolveCharacterLinks.js', () => ({
  resolveCharacterLinks: mockedResolveCharacterLinks,
}));

const { refreshLinkedCharacters } =
  await import('../../src/functions/applications/refreshLinkedCharacters.js');
const { startIntelJob } = await import('../../src/functions/applications/intel/placeholders.js');
const { getJob, getJobByApplication, getLinkedCharacters, topUpRequested } =
  await import('../../src/functions/applications/intel/jobStore.js');

const APPLICANT = { region: 'eu', realm: 'draenor', name: 'Brentpriest' };

/** A guild whose two application surfaces return the given message contents. */
function guildWith(surfaces: {
  channel?: string[] | 'missing';
  thread?: string[] | 'missing';
}): Guild {
  const channelFor = (contents: string[] | 'missing' | undefined, id: string) => {
    if (contents === undefined || contents === 'missing') return null;
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
  };

  return {
    channels: {
      fetch: vi.fn(async (id: string) => {
        if (id === 'CHAN') {
          if (surfaces.channel === 'missing') throw new Error('Missing Access');
          return channelFor(surfaces.channel, 'CHAN');
        }
        if (surfaces.thread === 'missing') throw new Error('Missing Access');
        return channelFor(surfaces.thread, 'THREAD');
      }),
    },
  } as unknown as Guild;
}

function seedApplication(status = 'active'): void {
  getDatabase()
    .prepare(
      `INSERT INTO applications (id, character_name, applicant_user_id, status, channel_id, thread_id)
       VALUES (4, 'Brentpriest', 'u1', ?, 'CHAN', 'THREAD')`,
    )
    .run(status);
}

describe('refreshLinkedCharacters', () => {
  beforeEach(() => {
    createTables(getDatabase(':memory:'));
    mockedResolveCharacterLinks.mockReset();
    seedApplication();
  });

  afterEach(() => closeDatabase());

  it('scans both surfaces and retains discoveries when one is unavailable', async () => {
    startIntelJob({ applicationId: 4, targetChannelId: 'THREAD', characters: [APPLICANT] });
    mockedResolveCharacterLinks.mockResolvedValue({
      identities: [{ region: 'eu', realm: 'draenor', name: 'New' }],
      statuses: [],
    });

    await expect(
      refreshLinkedCharacters(
        4,
        guildWith({ channel: 'missing', thread: ['https://raider.io/characters/eu/draenor/New'] }),
      ),
    ).resolves.toMatchObject({
      queued: ['New'],
      unavailableSurfaces: ['application channel'],
    });

    const jobId = getJobByApplication(4)!.id;
    expect(getLinkedCharacters(jobId).map((c) => c.name)).toEqual(['New']);
    expect(topUpRequested(jobId)).toBe(true);
  });

  it('does not re-queue a character the applicant already named', async () => {
    startIntelJob({ applicationId: 4, targetChannelId: 'THREAD', characters: [APPLICANT] });
    mockedResolveCharacterLinks.mockResolvedValue({
      identities: [APPLICANT],
      statuses: [],
    });

    await expect(
      refreshLinkedCharacters(
        4,
        guildWith({ channel: ['https://raider.io/characters/eu/draenor/Linked'], thread: [] }),
      ),
    ).resolves.toMatchObject({ queued: [] });

    const jobId = getJobByApplication(4)!.id;
    expect(getLinkedCharacters(jobId)).toEqual([]);
    expect(topUpRequested(jobId)).toBe(false);
  });

  // The rescue path: an application that named nobody holds an 'idle' job. The
  // first link both names its primary and makes it due.
  it('names the primary of an idle job and reopens it', async () => {
    startIntelJob({ applicationId: 4, targetChannelId: 'THREAD', characters: [] });
    mockedResolveCharacterLinks.mockResolvedValue({
      identities: [
        { region: 'eu', realm: 'draenor', name: 'Brentpriest' },
        { region: 'eu', realm: 'draenor', name: 'Second' },
      ],
      statuses: [],
    });

    const result = await refreshLinkedCharacters(
      4,
      guildWith({ channel: ['https://raider.io/characters/eu/draenor/Linked'], thread: [] }),
    );

    const job = getJobByApplication(4)!;
    expect(job.status).toBe('pending');
    // Name match against the application beats link order.
    expect(job.character_name).toBe('Brentpriest');
    expect(result.queued).toEqual(['Brentpriest', 'Second']);
  });

  it('falls back to the earliest resolved link when no name matches', async () => {
    getDatabase().prepare("UPDATE applications SET character_name = 'Nobody' WHERE id = 4").run();
    startIntelJob({ applicationId: 4, targetChannelId: 'THREAD', characters: [] });
    mockedResolveCharacterLinks.mockResolvedValue({
      identities: [
        { region: 'eu', realm: 'draenor', name: 'First' },
        { region: 'eu', realm: 'draenor', name: 'Second' },
      ],
      statuses: [],
    });

    await refreshLinkedCharacters(
      4,
      guildWith({ channel: ['https://raider.io/characters/eu/draenor/Linked'], thread: [] }),
    );

    expect(getJobByApplication(4)?.character_name).toBe('First');
  });

  it('refuses to refresh an application that is no longer active', async () => {
    getDatabase().prepare("UPDATE applications SET status = 'accepted' WHERE id = 4").run();
    startIntelJob({ applicationId: 4, targetChannelId: 'THREAD', characters: [APPLICANT] });

    await expect(
      refreshLinkedCharacters(
        4,
        guildWith({ channel: ['https://raider.io/characters/eu/draenor/Linked'], thread: [] }),
      ),
    ).resolves.toMatchObject({ outcome: 'inactive' });
    expect(mockedResolveCharacterLinks).not.toHaveBeenCalled();
  });

  it('reports when both surfaces are unreachable without touching the job', async () => {
    startIntelJob({ applicationId: 4, targetChannelId: 'THREAD', characters: [APPLICANT] });

    await expect(
      refreshLinkedCharacters(4, guildWith({ channel: 'missing', thread: 'missing' })),
    ).resolves.toMatchObject({
      outcome: 'no_surfaces',
      unavailableSurfaces: ['application channel', 'application thread'],
    });
    expect(mockedResolveCharacterLinks).not.toHaveBeenCalled();
    expect(topUpRequested(getJobByApplication(4)!.id)).toBe(false);
  });

  it('does no resolution work when neither surface contains a link', async () => {
    startIntelJob({ applicationId: 4, targetChannelId: 'THREAD', characters: [APPLICANT] });
    const jobId = getJobByApplication(4)!.id;

    await expect(
      refreshLinkedCharacters(4, guildWith({ channel: ['just chatting'], thread: [] })),
    ).resolves.toMatchObject({ outcome: 'ok', queued: [] });

    expect(mockedResolveCharacterLinks).not.toHaveBeenCalled();
    expect(getJob(jobId)?.status).toBe('pending');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from 'discord.js';
import { closeDatabase, getDatabase } from '../../src/database/db.js';
import { createTables } from '../../src/database/schema.js';

const { mockedResolveCharacterLinks, mockedHandleDmMessage } = vi.hoisted(() => ({
  mockedResolveCharacterLinks: vi.fn(),
  mockedHandleDmMessage: vi.fn(async () => undefined),
}));

vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/functions/applications/resolveCharacterLinks.js', () => ({
  resolveCharacterLinks: mockedResolveCharacterLinks,
}));

vi.mock('../../src/functions/applications/dmQuestionnaire.js', () => ({
  handleDmMessage: mockedHandleDmMessage,
}));

const event = (await import('../../src/events/messageCreate.js')).default;
const { startIntelJob } = await import('../../src/functions/applications/intel/placeholders.js');
const { getJobByApplication, getLinkedCharacters, topUpRequested } =
  await import('../../src/functions/applications/intel/jobStore.js');

const LINK = 'https://raider.io/characters/eu/draenor/Brenthunter';
const HUNTER = { region: 'eu', realm: 'draenor', name: 'Brenthunter' };
const APPLICANT = { region: 'eu', realm: 'draenor', name: 'Brentpriest' };

function message(
  content: string,
  overrides: { channelId?: string; bot?: boolean; guild?: boolean } = {},
): Message {
  return {
    content,
    channelId: overrides.channelId ?? 'CHAN',
    author: { bot: overrides.bot ?? false },
    guild: overrides.guild === false ? null : { id: 'G' },
  } as unknown as Message;
}

function seedApplication(status = 'active'): void {
  getDatabase()
    .prepare(
      `INSERT INTO applications (id, character_name, applicant_user_id, status, channel_id, thread_id)
       VALUES (4, 'Brentpriest', 'u1', ?, 'CHAN', 'THREAD')`,
    )
    .run(status);
}

describe('messageCreate harvests linked characters', () => {
  beforeEach(() => {
    createTables(getDatabase(':memory:'));
    mockedResolveCharacterLinks.mockReset();
    mockedResolveCharacterLinks.mockResolvedValue({ identities: [HUNTER], statuses: [] });
    mockedHandleDmMessage.mockClear();
    seedApplication();
  });

  afterEach(() => closeDatabase());

  it('does no resolution work without a URL candidate', async () => {
    startIntelJob({ applicationId: 4, targetChannelId: 'THREAD', characters: [APPLICANT] });

    await event.execute(message('hello, when are trials?'));

    expect(mockedResolveCharacterLinks).not.toHaveBeenCalled();
    expect(topUpRequested(getJobByApplication(4)!.id)).toBe(false);
  });

  it.each(['CHAN', 'THREAD'])('harvests from the application %s', async (channelId) => {
    startIntelJob({ applicationId: 4, targetChannelId: 'THREAD', characters: [APPLICANT] });

    await event.execute(message(LINK, { channelId }));

    const jobId = getJobByApplication(4)!.id;
    expect(getLinkedCharacters(jobId).map((c) => c.name)).toEqual(['Brenthunter']);
    expect(topUpRequested(jobId)).toBe(true);
  });

  it('ignores bot and webhook messages before touching the database', async () => {
    startIntelJob({ applicationId: 4, targetChannelId: 'THREAD', characters: [APPLICANT] });

    await event.execute(message(LINK, { bot: true }));

    expect(mockedResolveCharacterLinks).not.toHaveBeenCalled();
    expect(getLinkedCharacters(getJobByApplication(4)!.id)).toEqual([]);
  });

  it('ignores a link in a channel with no active application', async () => {
    startIntelJob({ applicationId: 4, targetChannelId: 'THREAD', characters: [APPLICANT] });

    await event.execute(message(LINK, { channelId: 'SOMEWHERE_ELSE' }));

    expect(mockedResolveCharacterLinks).not.toHaveBeenCalled();
    expect(getLinkedCharacters(getJobByApplication(4)!.id)).toEqual([]);
  });

  it('ignores a link once the application is no longer active', async () => {
    getDatabase().prepare("UPDATE applications SET status = 'accepted' WHERE id = 4").run();
    startIntelJob({ applicationId: 4, targetChannelId: 'THREAD', characters: [APPLICANT] });

    await event.execute(message(LINK));

    expect(mockedResolveCharacterLinks).not.toHaveBeenCalled();
  });

  it('does not re-request a top-up for a character already known', async () => {
    startIntelJob({ applicationId: 4, targetChannelId: 'THREAD', characters: [APPLICANT, HUNTER] });

    await event.execute(message(LINK));

    const jobId = getJobByApplication(4)!.id;
    expect(getLinkedCharacters(jobId)).toEqual([]);
    expect(topUpRequested(jobId)).toBe(false);
  });

  // A link appended while a sweep is mid-flight must still register: runJob
  // clears the request bit before its first await, so a later request survives
  // as a replay rather than being consumed by the run already in progress.
  it('records an append against a running job', async () => {
    startIntelJob({ applicationId: 4, targetChannelId: 'THREAD', characters: [APPLICANT] });
    const jobId = getJobByApplication(4)!.id;
    getDatabase()
      .prepare("UPDATE applicant_intel_jobs SET status = 'running' WHERE id = ?")
      .run(jobId);

    await event.execute(message(LINK));

    expect(topUpRequested(jobId)).toBe(true);
    // Still running: a top-up request must never interrupt a live sweep.
    expect(getJobByApplication(4)?.status).toBe('running');
  });

  it('leaves the DM questionnaire path untouched', async () => {
    await event.execute(message(LINK, { guild: false }));

    expect(mockedHandleDmMessage).toHaveBeenCalledTimes(1);
    expect(mockedResolveCharacterLinks).not.toHaveBeenCalled();
  });

  it('swallows a resolution failure rather than breaking the event', async () => {
    startIntelJob({ applicationId: 4, targetChannelId: 'THREAD', characters: [APPLICANT] });
    mockedResolveCharacterLinks.mockRejectedValue(new Error('Raider.IO is down'));

    await expect(event.execute(message(LINK))).resolves.toBeUndefined();
    expect(topUpRequested(getJobByApplication(4)!.id)).toBe(false);
  });
});

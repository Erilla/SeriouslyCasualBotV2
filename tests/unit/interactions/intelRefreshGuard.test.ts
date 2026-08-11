import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ButtonInteraction } from 'discord.js';
import { closeDatabase, getDatabase } from '../../../src/database/db.js';
import { createTables } from '../../../src/database/schema.js';

const { mockedRefreshLinkedCharacters, mockedSyncRefreshControl } = vi.hoisted(() => ({
  mockedRefreshLinkedCharacters: vi.fn(),
  mockedSyncRefreshControl: vi.fn(async () => undefined),
}));

vi.mock('../../../src/config.js', () => ({ config: { officerRoleId: 'OFFICER' } }));
vi.mock('../../../src/services/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../src/services/auditLog.js', () => ({
  audit: vi.fn(async () => undefined),
  alertOfficers: vi.fn(async () => undefined),
}));
vi.mock('../../../src/functions/applications/refreshLinkedCharacters.js', () => ({
  refreshLinkedCharacters: mockedRefreshLinkedCharacters,
}));
vi.mock('../../../src/functions/applications/intel/syncRefreshControl.js', () => ({
  syncRefreshControl: mockedSyncRefreshControl,
}));

import { buttons } from '../../../src/interactions/application.js';
import { startIntelJob } from '../../../src/functions/applications/intel/placeholders.js';
import { setStatus } from '../../../src/functions/applications/intel/jobStore.js';

const handle = (() => {
  const found = buttons.find((b) => b.prefix === 'application:intel_refresh');
  if (!found) throw new Error('intel_refresh handler not registered');
  return found.handle;
})();

function stubInteraction() {
  const editReply = vi.fn(async () => undefined);
  // resolveMember FETCHES the member rather than reading interaction.member, so
  // the officer role has to be reachable through guild.members.fetch.
  const officer = { roles: { cache: new Map([['OFFICER', {}]]) } };
  return {
    interaction: {
      user: { id: 'U1', tag: 'Officer#0001' },
      client: {},
      guild: { id: 'G1', members: { fetch: vi.fn(async () => officer) } },
      reply: vi.fn(async () => undefined),
      deferReply: vi.fn(async () => undefined),
      editReply,
    } as unknown as ButtonInteraction,
    editReply,
  };
}

/** An active application with an intel job in the given status. */
function seed(status: 'pending' | 'running' | 'done' | 'paused'): number {
  const applicationId = Number(
    getDatabase()
      .prepare(
        `INSERT INTO applications (applicant_user_id, status, character_name, channel_id, thread_id)
         VALUES ('U1', 'active', 'Kiuasdk', 'CHAN', 'THREAD')`,
      )
      .run().lastInsertRowid,
  );
  const jobId = startIntelJob({
    applicationId,
    targetChannelId: 'THREAD',
    characters: [{ region: 'eu', realm: 'tarren-mill', name: 'Kiuasdk' }],
    refreshMessageId: 'CONTROL',
  });
  setStatus(jobId, status);
  return applicationId;
}

beforeEach(() => {
  closeDatabase();
  createTables(getDatabase(':memory:'));
  vi.clearAllMocks();
  mockedRefreshLinkedCharacters.mockResolvedValue({
    outcome: 'ok',
    queued: ['Braene'],
    unavailableSurfaces: [],
    truncated: false,
  });
});

afterEach(() => {
  closeDatabase();
});

describe('the Refresh control while a sweep is in flight', () => {
  it('refuses to rescan while a sweep is running', async () => {
    const applicationId = seed('running');
    const { interaction, editReply } = stubInteraction();

    await handle(interaction, [String(applicationId)]);

    expect(mockedRefreshLinkedCharacters).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('already') }),
    );
  });

  it('refuses to rescan while a sweep is queued', async () => {
    const applicationId = seed('pending');
    const { interaction } = stubInteraction();

    await handle(interaction, [String(applicationId)]);

    expect(mockedRefreshLinkedCharacters).not.toHaveBeenCalled();
  });

  it('redraws the stale control it was clicked from, so it disables itself', async () => {
    // The control's message is never deleted, so Discord routes a click from a
    // row drawn before the sweep started. Refusing without redrawing would leave
    // that button enabled until the next scheduler tick.
    const applicationId = seed('running');
    const { interaction } = stubInteraction();

    await handle(interaction, [String(applicationId)]);

    expect(mockedSyncRefreshControl).toHaveBeenCalled();
  });

  it('rescans and then redraws the control when no sweep is in flight', async () => {
    const applicationId = seed('done');
    const { interaction, editReply } = stubInteraction();

    await handle(interaction, [String(applicationId)]);

    expect(mockedRefreshLinkedCharacters).toHaveBeenCalledTimes(1);
    // Redrawn after queueing so the button reads "Refreshing…" immediately
    // rather than staying live until the scheduler catches up.
    expect(mockedSyncRefreshControl).toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Braene') }),
    );
  });

  it('still rescans a paused sweep, which is waiting rather than working', async () => {
    const applicationId = seed('paused');
    const { interaction } = stubInteraction();

    await handle(interaction, [String(applicationId)]);

    expect(mockedRefreshLinkedCharacters).toHaveBeenCalledTimes(1);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModalSubmitInteraction } from 'discord.js';
import { closeDatabase, getDatabase, initDatabase } from '../../../src/database/db.js';

const mocks = vi.hoisted(() => ({
  getOrCreateGuildInfoChannel: vi.fn(),
  audit: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock('../../../src/functions/guild-info/clearGuildInfo.js', () => ({
  getOrCreateGuildInfoChannel: mocks.getOrCreateGuildInfoChannel,
}));
vi.mock('../../../src/services/auditLog.js', () => ({ audit: mocks.audit }));
vi.mock('../../../src/services/logger.js', () => ({
  logger: {
    error: mocks.loggerError,
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

import { modals as guildInfoModals } from '../../../src/interactions/guildInfo.js';

describe('guild info modal channel-resolution failure', () => {
  beforeEach(() => {
    closeDatabase();
    initDatabase(':memory:');
    vi.clearAllMocks();
    mocks.getOrCreateGuildInfoChannel.mockResolvedValue(null);
  });

  afterEach(() => {
    closeDatabase();
  });

  it('keeps the About Us edit and reports refresh failure when the real renderer cannot resolve its channel', async () => {
    const interaction = {
      fields: {
        getTextInputValue: vi.fn((name: string) =>
          name === 'title' ? 'Changed About Us' : 'Changed body',
        ),
      },
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      client: {},
      user: {},
    };

    await guildInfoModals[0]!.handle(interaction as unknown as ModalSubmitInteraction, ['about']);

    const saved = getDatabase()
      .prepare('SELECT title, content FROM guild_info_content WHERE key = ?')
      .get('aboutus') as { title: string; content: string };
    expect(saved).toEqual({ title: 'Changed About Us', content: 'Changed body' });
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: 'Saved, but the Guild Info message could not be refreshed. Run /guildinfo to retry.',
    });
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.loggerError).toHaveBeenCalledWith(
      'guild-info',
      expect.stringContaining('Could not resolve guild info channel for About Us'),
      expect.any(Error),
    );
  });
});

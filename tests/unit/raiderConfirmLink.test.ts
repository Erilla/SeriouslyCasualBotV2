import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageFlags } from 'discord.js';
import type { ButtonInteraction } from 'discord.js';

vi.mock('../../src/config.js', () => ({ config: { guildId: 'guild-123' } }));

vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/database/db.js', () => ({ getDatabase: vi.fn() }));

vi.mock('../../src/services/auditLog.js', () => ({
  audit: vi.fn(),
  setAuditChannel: vi.fn(),
  alertOfficers: vi.fn(),
}));

vi.mock('../../src/functions/raids/updateRaiderDiscordUser.js', () => ({
  updateRaiderDiscordUser: vi.fn(),
}));

vi.mock('../../src/functions/raids/ignoreCharacter.js', () => ({
  ignoreCharacter: vi.fn(),
}));

vi.mock('../../src/functions/raids/sendAlertForRaidersWithNoUser.js', () => ({
  sendAlertForRaidersWithNoUser: vi.fn(),
}));

import { buttons } from '../../src/interactions/raider.js';
import { updateRaiderDiscordUser } from '../../src/functions/raids/updateRaiderDiscordUser.js';
import { audit } from '../../src/services/auditLog.js';

const mockedUpdate = vi.mocked(updateRaiderDiscordUser);
const mockedAudit = vi.mocked(audit);

const confirmLink = buttons.find((b) => b.prefix === 'raider:confirm_link')!.handle;

function makeInteraction() {
  return {
    client: {},
    user: { id: 'officer-1', displayName: 'Officer' },
    message: { delete: vi.fn().mockResolvedValue(undefined) },
    update: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as ButtonInteraction & {
    update: ReturnType<typeof vi.fn>;
    reply: ReturnType<typeof vi.fn>;
    message: { delete: ReturnType<typeof vi.fn> };
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('confirmLink button', () => {
  it('replies ephemerally and does not leave a public message in the channel', async () => {
    mockedUpdate.mockResolvedValue(true);
    const interaction = makeInteraction();

    await confirmLink(interaction, ['Thrall', 'user-9']);

    // No public message edit — the linking confirmation must be ephemeral.
    expect(interaction.update).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledTimes(1);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ flags: MessageFlags.Ephemeral }),
    );
  });

  it('records the link in the audit log', async () => {
    mockedUpdate.mockResolvedValue(true);
    const interaction = makeInteraction();

    await confirmLink(interaction, ['Thrall', 'user-9']);

    expect(mockedAudit).toHaveBeenCalledWith(
      interaction.user,
      'confirmed raider link',
      expect.stringContaining('Thrall'),
    );
  });
});

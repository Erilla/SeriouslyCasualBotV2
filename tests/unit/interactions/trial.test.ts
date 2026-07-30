import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ButtonInteraction } from 'discord.js';

const mocks = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  audit: vi.fn(),
  extendTrial: vi.fn(),
}));

vi.mock('../../../src/database/db.js', () => ({ getDatabase: mocks.getDatabase }));
vi.mock('../../../src/services/auditLog.js', () => ({ audit: mocks.audit }));
vi.mock('../../../src/functions/trial-review/extendTrial.js', () => ({
  extendTrial: mocks.extendTrial,
}));
vi.mock('../../../src/functions/trial-review/markForPromotion.js', () => ({
  markForPromotion: vi.fn(),
}));
vi.mock('../../../src/functions/trial-review/closeTrial.js', () => ({ closeTrial: vi.fn() }));
vi.mock('../../../src/functions/trial-review/changeTrialInfo.js', () => ({
  changeTrialInfo: vi.fn(),
}));
vi.mock('../../../src/functions/trial-review/createTrialReviewThread.js', () => ({
  createTrialReviewThread: vi.fn(),
}));

import { buttons } from '../../../src/interactions/trial.js';
import { audit } from '../../../src/services/auditLog.js';

function getExtendHandler() {
  const handler = buttons.find((button) => button.prefix === 'trial:extend');
  if (!handler) throw new Error('trial:extend handler not registered');
  return handler.handle;
}

describe('trial:extend button', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.extendTrial.mockResolvedValue(undefined);
    mocks.getDatabase.mockReturnValue({
      prepare: vi.fn().mockReturnValue({
        get: vi
          .fn()
          .mockReturnValueOnce({ id: 3, character_name: 'Binded', thread_id: '456' })
          .mockReturnValueOnce({ alert_date: '2026-08-06' }),
      }),
    });
  });

  it('audits the persisted six-week review date after extending a trial', async () => {
    const interaction = {
      client: {},
      user: { id: 'user-1' },
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
    } as unknown as ButtonInteraction;

    await getExtendHandler()(interaction, ['3']);

    expect(audit).toHaveBeenCalledWith(
      interaction.user,
      'extended trial',
      '**Binded** — <#456>; ends <t:1785974400:D>',
    );
    expect(interaction.editReply).toHaveBeenCalledWith({ content: 'Trial extended by 1 week.' });
  });
});

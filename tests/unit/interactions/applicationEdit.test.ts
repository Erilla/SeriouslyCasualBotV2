import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ButtonInteraction } from 'discord.js';

vi.mock('../../../src/config.js', () => ({ config: {} }));
vi.mock('../../../src/services/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../src/functions/applications/dmQuestionnaire.js', () => ({
  activeSessions: new Map(),
  enterEditMode: vi.fn(),
  startSessionTimeout: vi.fn(),
}));

import { buttons } from '../../../src/interactions/application.js';
import {
  activeSessions,
  enterEditMode,
  startSessionTimeout,
} from '../../../src/functions/applications/dmQuestionnaire.js';

function getEditHandler() {
  const handler = buttons.find((b) => b.prefix === 'application:edit');
  if (!handler) throw new Error('application:edit handler not registered');
  return handler.handle;
}

function stubInteraction(sendImpl?: () => Promise<unknown>) {
  return {
    user: {
      id: 'U1',
      send: sendImpl ? vi.fn(sendImpl) : vi.fn().mockResolvedValue(undefined),
    },
    reply: vi.fn().mockResolvedValue(undefined),
    deferUpdate: vi.fn().mockResolvedValue(undefined),
  } as unknown as ButtonInteraction;
}

describe('application:edit button', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeSessions.clear();
  });

  it('DMs the edit prompt and enters edit mode', async () => {
    const handle = getEditHandler();
    const interaction = stubInteraction();

    await handle(interaction, ['42']);

    expect(enterEditMode).toHaveBeenCalledWith('U1', 42);
    expect(startSessionTimeout).toHaveBeenCalled();
    expect(interaction.user.send).toHaveBeenCalledWith(
      'Which answer would you like to change? (enter the number)',
    );
  });

  it('acknowledges the interaction silently without the redundant "check your DMs" reply', async () => {
    // The Edit Answer button only ever appears inside the applicant's DMs
    // (showSummary always uses user.send), so telling them to "check your DMs"
    // is redundant. The button click is acknowledged with deferUpdate instead.
    const handle = getEditHandler();
    const interaction = stubInteraction();

    await handle(interaction, ['42']);

    expect(interaction.deferUpdate).toHaveBeenCalledTimes(1);
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it('replies with an error and clears the session when the DM cannot be sent', async () => {
    const handle = getEditHandler();
    const interaction = stubInteraction(() => Promise.reject(new Error('DMs closed')));
    activeSessions.set('U1', { applicationId: 42, questionIndex: 0 });

    await handle(interaction, ['42']);

    expect(activeSessions.has('U1')).toBe(false);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('unable to send you a DM'),
      }),
    );
  });
});

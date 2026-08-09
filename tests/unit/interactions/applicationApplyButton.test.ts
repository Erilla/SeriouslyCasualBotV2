import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ButtonInteraction } from 'discord.js';

const { mockedStartApplication, mockedResolveMember } = vi.hoisted(() => ({
  mockedStartApplication: vi.fn(),
  mockedResolveMember: vi.fn(async () => null),
}));

vi.mock('../../../src/config.js', () => ({ config: {} }));
vi.mock('../../../src/services/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../src/services/auditLog.js', () => ({
  audit: vi.fn(async () => undefined),
  alertOfficers: vi.fn(async () => undefined),
}));
vi.mock('../../../src/functions/applications/startApplication.js', () => ({
  startApplication: mockedStartApplication,
}));
vi.mock('../../../src/functions/applications/resolveMember.js', () => ({
  resolveMember: mockedResolveMember,
}));
vi.mock('../../../src/functions/applications/submitApplication.js', () => ({
  submitApplication: vi.fn(),
}));
vi.mock('../../../src/functions/applications/dmQuestionnaire.js', () => ({
  activeSessions: new Map(),
  enterEditMode: vi.fn(),
  startSessionTimeout: vi.fn(),
}));

import { buttons } from '../../../src/interactions/application.js';

function getApplyHandler() {
  const handler = buttons.find((b) => b.prefix === 'application:apply');
  if (!handler) throw new Error('application:apply handler not registered');
  return handler.handle;
}

function stubInteraction() {
  return {
    user: { id: 'U1', tag: 'App#0001' },
    guild: null,
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
  } as unknown as ButtonInteraction;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedStartApplication.mockResolvedValue({ outcome: 'started' });
});

describe('application:apply button', () => {
  it('acknowledges Discord before doing any slow work', async () => {
    // Discord invalidates the interaction token 3 seconds after delivery. This
    // handler fetches the guild member and sends a DM before it can say
    // anything, so it must defer first or the applicant sees "This interaction
    // failed" even when the application was created successfully.
    const interaction = stubInteraction();

    await getApplyHandler()(interaction, []);

    expect(interaction.deferReply).toHaveBeenCalledTimes(1);
    const deferOrder = vi.mocked(interaction.deferReply).mock.invocationCallOrder[0];
    expect(mockedResolveMember.mock.invocationCallOrder[0]).toBeGreaterThan(deferOrder);
    expect(mockedStartApplication.mock.invocationCallOrder[0]).toBeGreaterThan(deferOrder);
  });

  it('defers ephemerally so the acknowledgement stays private', async () => {
    const interaction = stubInteraction();

    await getApplyHandler()(interaction, []);

    expect(interaction.deferReply).toHaveBeenCalledWith(
      expect.objectContaining({ flags: expect.anything() }),
    );
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it('sends the success message through editReply', async () => {
    const interaction = stubInteraction();

    await getApplyHandler()(interaction, []);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Check your DMs') }),
    );
  });

  it('reports a refusal reason through editReply', async () => {
    mockedStartApplication.mockResolvedValue({
      outcome: 'refused',
      reason: 'already_raider',
      message: "You're already a raider — there's no need to apply.",
    });
    const interaction = stubInteraction();

    await getApplyHandler()(interaction, []);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: "You're already a raider — there's no need to apply." }),
    );
  });

  it('reports a DM failure distinctly from a refusal', async () => {
    mockedStartApplication.mockResolvedValue({ outcome: 'dm_failed' });
    const interaction = stubInteraction();

    await getApplyHandler()(interaction, []);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('unable to send you a DM') }),
    );
  });
});

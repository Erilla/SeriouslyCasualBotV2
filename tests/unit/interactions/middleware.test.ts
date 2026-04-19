import { describe, it, expect, vi } from 'vitest';
import type { ButtonInteraction } from 'discord.js';
import { requireOfficer, wrapErrors } from '../../../src/interactions/middleware.js';

vi.mock('../../../src/config.js', () => ({
  config: { officerRoleId: 'OFFICER' },
}));

vi.mock('../../../src/services/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

function stubInteraction(opts: {
  hasRole?: boolean;
  replied?: boolean;
  deferred?: boolean;
} = {}) {
  return {
    member: { roles: { cache: { has: (id: string) => opts.hasRole === true && id === 'OFFICER' } } },
    replied: opts.replied ?? false,
    deferred: opts.deferred ?? false,
    reply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
  } as unknown as ButtonInteraction;
}

describe('requireOfficer', () => {
  it('returns true when the member has the officer role', async () => {
    const interaction = stubInteraction({ hasRole: true });
    const allowed = await requireOfficer(interaction);
    expect(allowed).toBe(true);
    expect((interaction as any).reply).not.toHaveBeenCalled();
  });

  it('returns false and replies ephemeral when the member lacks the role', async () => {
    const interaction = stubInteraction({ hasRole: false });
    const allowed = await requireOfficer(interaction);
    expect(allowed).toBe(false);
    expect((interaction as any).reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringMatching(/permission/i) }),
    );
  });
});

describe('wrapErrors', () => {
  it('runs the function when it succeeds', async () => {
    const interaction = stubInteraction();
    const fn = vi.fn().mockResolvedValue(undefined);
    await wrapErrors('button', 'test:id', interaction, fn);
    expect(fn).toHaveBeenCalled();
    expect((interaction as any).reply).not.toHaveBeenCalled();
  });

  it('replies ephemeral when the fn throws and interaction is fresh', async () => {
    const interaction = stubInteraction({ replied: false, deferred: false });
    const fn = vi.fn().mockRejectedValue(new Error('boom'));
    await wrapErrors('button', 'test:id', interaction, fn);
    expect((interaction as any).reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringMatching(/error/i) }),
    );
  });

  it('followUps ephemeral when the fn throws and interaction was already replied', async () => {
    const interaction = stubInteraction({ replied: true });
    const fn = vi.fn().mockRejectedValue(new Error('boom'));
    await wrapErrors('button', 'test:id', interaction, fn);
    expect((interaction as any).followUp).toHaveBeenCalled();
    expect((interaction as any).reply).not.toHaveBeenCalled();
  });

  it('followUps ephemeral when the fn throws and interaction was deferred', async () => {
    const interaction = stubInteraction({ deferred: true });
    const fn = vi.fn().mockRejectedValue(new Error('boom'));
    await wrapErrors('button', 'test:id', interaction, fn);
    expect((interaction as any).followUp).toHaveBeenCalled();
  });
});

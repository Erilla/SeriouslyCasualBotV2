import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ButtonInteraction } from 'discord.js';
import { dispatch, type ButtonHandler } from '../../../src/interactions/registry.js';

vi.mock('../../../src/config.js', () => ({ config: { officerRoleId: 'OFFICER' } }));
vi.mock('../../../src/services/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

function stubInteraction(opts: { hasRole?: boolean } = {}) {
  return {
    member: { roles: { cache: { has: () => opts.hasRole === true } } },
    replied: false,
    deferred: false,
    reply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
  } as unknown as ButtonInteraction;
}

describe('dispatch', () => {
  let handleA: ReturnType<typeof vi.fn>;
  let handleB: ReturnType<typeof vi.fn>;
  let handlers: ButtonHandler[];

  beforeEach(() => {
    handleA = vi.fn().mockResolvedValue(undefined);
    handleB = vi.fn().mockResolvedValue(undefined);
    handlers = [
      { prefix: 'foo:exact', handle: handleA },
      { prefix: 'foo:prefixed', handle: handleB },
    ];
  });

  it('routes an exact-match customId to the right handler with empty params', async () => {
    await dispatch(handlers, 'button', stubInteraction(), 'foo:exact');
    expect(handleA).toHaveBeenCalledWith(expect.anything(), []);
    expect(handleB).not.toHaveBeenCalled();
  });

  it('routes a prefix-with-colon customId and splits the tail into params', async () => {
    await dispatch(handlers, 'button', stubInteraction(), 'foo:prefixed:42:abc');
    expect(handleB).toHaveBeenCalledWith(expect.anything(), ['42', 'abc']);
  });

  it('logs a warning, returns false, and calls no handler when no prefix matches', async () => {
    const { logger } = await import('../../../src/services/logger.js');
    const result = await dispatch(handlers, 'button', stubInteraction(), 'unknown:id');
    expect(result).toBe(false);
    expect(handleA).not.toHaveBeenCalled();
    expect(handleB).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('interaction', expect.stringMatching(/Unhandled button: unknown:id/));
  });

  it('returns true when a handler runs', async () => {
    const result = await dispatch(handlers, 'button', stubInteraction(), 'foo:exact');
    expect(result).toBe(true);
  });

  it('does not route foo:prefixedextra to the foo:prefixed handler (boundary check)', async () => {
    await dispatch(handlers, 'button', stubInteraction(), 'foo:prefixedextra');
    expect(handleB).not.toHaveBeenCalled();
  });

  it('short-circuits when officerOnly is true and the gate fails', async () => {
    const gated: ButtonHandler[] = [{ prefix: 'gated', officerOnly: true, handle: handleA }];
    const interaction = stubInteraction({ hasRole: false });
    await dispatch(gated, 'button', interaction, 'gated');
    expect(handleA).not.toHaveBeenCalled();
    expect((interaction as any).reply).toHaveBeenCalled();
  });

  it('runs when officerOnly is true and the gate passes', async () => {
    const gated: ButtonHandler[] = [{ prefix: 'gated', officerOnly: true, handle: handleA }];
    const interaction = stubInteraction({ hasRole: true });
    await dispatch(gated, 'button', interaction, 'gated');
    expect(handleA).toHaveBeenCalled();
  });

  it('catches and logs a handler throw via wrapErrors', async () => {
    const throwing: ButtonHandler[] = [{ prefix: 'boom', handle: vi.fn().mockRejectedValue(new Error('kaboom')) }];
    const interaction = stubInteraction();
    await dispatch(throwing, 'button', interaction, 'boom');
    expect((interaction as any).reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringMatching(/error/i) }),
    );
  });
});

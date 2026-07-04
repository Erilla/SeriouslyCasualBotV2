import { describe, it, expect, vi } from 'vitest';
import { closeThread } from '../../src/functions/threads.js';

describe('closeThread', () => {
  it('locks and archives the thread in a single edit', async () => {
    const thread = { edit: vi.fn(async () => undefined) };

    await closeThread(thread as never);

    expect(thread.edit).toHaveBeenCalledTimes(1);
    expect(thread.edit).toHaveBeenCalledWith({ locked: true, archived: true });
  });

  it('propagates errors so callers can keep their best-effort try/catch', async () => {
    const thread = {
      edit: vi.fn(async () => {
        throw new Error('Missing Permissions');
      }),
    };

    await expect(closeThread(thread as never)).rejects.toThrow('Missing Permissions');
  });
});

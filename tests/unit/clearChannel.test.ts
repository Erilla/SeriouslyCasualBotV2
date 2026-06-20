import { describe, it, expect, vi } from 'vitest';
import { clearChannel } from '../../src/functions/clearChannel.js';

// Minimal channel stub: `fetchSizes` are the sizes returned by successive
// messages.fetch() calls; `deleteSizes` (optional) the sizes returned by
// successive bulkDelete() calls (defaults to the fetched size = all deletable).
function makeChannel(fetchSizes: number[], deleteSizes?: number[]) {
  let i = 0;
  return {
    messages: {
      fetch: vi.fn(async () => ({ size: fetchSizes[i] ?? 0 })),
    },
    bulkDelete: vi.fn(async (fetched: { size: number }) => {
      const removed = deleteSizes ? (deleteSizes[i] ?? 0) : fetched.size;
      i += 1;
      return { size: removed };
    }),
  };
}

describe('clearChannel', () => {
  it('bulk-deletes across batches until the channel is empty', async () => {
    const channel = makeChannel([100, 50, 0]);

    const result = await clearChannel(channel as never);

    expect(result).toEqual({ deleted: 150, skippedOld: false });
    expect(channel.bulkDelete).toHaveBeenCalledTimes(2);
    expect(channel.messages.fetch).toHaveBeenCalledTimes(3);
    // Always bulk-deletes with filterOld = true.
    expect(channel.bulkDelete).toHaveBeenCalledWith(expect.anything(), true);
  });

  it('reports skippedOld when some messages are older than 14 days', async () => {
    // Fetched 100 but only 40 were deletable → the rest are >14 days old.
    const channel = makeChannel([100], [40]);

    const result = await clearChannel(channel as never);

    expect(result).toEqual({ deleted: 40, skippedOld: true });
    expect(channel.bulkDelete).toHaveBeenCalledTimes(1);
  });

  it('handles an empty channel without calling bulkDelete', async () => {
    const channel = makeChannel([0]);

    const result = await clearChannel(channel as never);

    expect(result).toEqual({ deleted: 0, skippedOld: false });
    expect(channel.bulkDelete).not.toHaveBeenCalled();
  });
});

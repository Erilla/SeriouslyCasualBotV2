import { describe, it, expect } from 'vitest';
import { mapLimit } from '../../src/utils/concurrency.js';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('mapLimit', () => {
  it('returns results in input order', async () => {
    const out = await mapLimit([3, 1, 2], 2, async (n) => {
      await tick(n * 5);
      return n * 10;
    });
    expect(out).toEqual([30, 10, 20]);
  });

  it('never exceeds the concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    await mapLimit(
      Array.from({ length: 20 }, (_, i) => i),
      4,
      async () => {
        active++;
        peak = Math.max(peak, active);
        await tick(2);
        active--;
      },
    );
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('passes the index to the callback', async () => {
    expect(await mapLimit(['a', 'b'], 1, async (item, i) => `${i}:${item}`)).toEqual([
      '0:a',
      '1:b',
    ]);
  });

  it('handles an empty input', async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
  });

  it('rejects if a task rejects', async () => {
    await expect(
      mapLimit([1, 2], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
  });

  // FINAL REVIEW M1: the callback commits durable state (the alt sweep's
  // markScanned), so a sibling worker that keeps draining the list after a
  // rejection permanently poisons resume state for items whose results are
  // discarded with the abandoned promise. On the first rejection no worker may
  // pick up a NEW item; only those already in flight may finish.
  it('stops handing out new items after a rejection', async () => {
    const started: number[] = [];
    await expect(
      mapLimit(
        Array.from({ length: 10 }, (_, i) => i),
        2,
        async (n) => {
          started.push(n);
          // Item 0 fails fast, so the abort lands while the only sibling worker
          // is still inside its first call.
          if (n === 0) {
            await tick(1);
            throw new Error('429');
          }
          await tick(5);
          return n;
        },
      ),
    ).rejects.toThrow('429');

    // The rejection reaches the caller while the sibling worker is still
    // awaiting, so the assertion must be made AFTER long enough for that worker
    // to have drained the rest of the list had nothing stopped it. Pre-fix it
    // ran every remaining item; post-fix, only the two already in flight.
    await tick(120);
    expect(started).toEqual([0, 1]);
  });

  it('still resolves every item when nothing rejects', async () => {
    const out = await mapLimit(
      Array.from({ length: 10 }, (_, i) => i),
      3,
      async (n) => n * 2,
    );
    expect(out).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18]);
  });
});

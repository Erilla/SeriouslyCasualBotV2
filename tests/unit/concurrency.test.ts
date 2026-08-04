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
});

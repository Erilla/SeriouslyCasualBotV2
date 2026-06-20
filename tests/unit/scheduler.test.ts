import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Scheduler } from '../../src/scheduler/scheduler.js';

describe('Scheduler', () => {
  let scheduler: Scheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    // Pin the clock to an exact epoch boundary so the existing "+intervalMs"
    // assertions still line up under boundary-aligned scheduling.
    vi.setSystemTime(0);
    scheduler = new Scheduler();
  });

  afterEach(() => {
    scheduler.shutdown();
    vi.useRealTimers();
  });

  it('aligns the first tick to the next wall-clock boundary, not bot-start time', async () => {
    // 00:03:30 — 3m30s past a 10-minute boundary.
    vi.setSystemTime(Date.parse('2026-01-01T00:03:30.000Z'));
    const handler = vi.fn().mockResolvedValue(undefined);

    scheduler.registerInterval({ name: 'aligned', intervalMs: 600_000, handler });
    scheduler.start();

    // Advance to 00:09:30 — still before the 00:10:00 boundary.
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(handler).toHaveBeenCalledTimes(0);

    // Cross 00:10:00.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(handler).toHaveBeenCalledTimes(1);

    // Next fire is the following boundary, 00:20:00.
    await vi.advanceTimersByTimeAsync(600_000);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('re-aligns to the next boundary after a long-running handler', async () => {
    // 00:00:00 boundary. A handler that takes 12 minutes should cause the
    // 00:10:00 tick to be skipped, with the next real fire at 00:20:00.
    vi.setSystemTime(Date.parse('2026-01-01T00:00:00.000Z'));
    let resolveHandler: () => void = () => {};
    const handler = vi.fn(() => new Promise<void>((r) => (resolveHandler = r)));

    scheduler.registerInterval({ name: 'slow', intervalMs: 600_000, handler });
    scheduler.start();

    await vi.advanceTimersByTimeAsync(600_000); // 00:10:00 — first fire, handler now pending
    expect(handler).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(600_000); // 00:20:00 — still running, skipped
    expect(handler).toHaveBeenCalledTimes(1);

    resolveHandler(); // handler finishes at ~00:20:00
    await vi.advanceTimersByTimeAsync(600_000); // 00:30:00 — fires again
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('should register and run an interval task', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);

    scheduler.registerInterval({
      name: 'testTask',
      intervalMs: 1000,
      handler,
    });

    scheduler.start();

    await vi.advanceTimersByTimeAsync(1000);
    expect(handler).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('should prevent overlapping executions', async () => {
    let resolveHandler: () => void;
    const handlerPromise = new Promise<void>((resolve) => {
      resolveHandler = resolve;
    });

    const handler = vi.fn().mockReturnValue(handlerPromise);

    scheduler.registerInterval({
      name: 'slowTask',
      intervalMs: 100,
      handler,
    });

    scheduler.start();

    await vi.advanceTimersByTimeAsync(100);
    expect(handler).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(handler).toHaveBeenCalledTimes(1); // Still 1, not 2

    resolveHandler!();
  });

  it('should catch and log errors without crashing', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('task failed'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    scheduler.registerInterval({
      name: 'failingTask',
      intervalMs: 1000,
      handler,
    });

    scheduler.start();

    await vi.advanceTimersByTimeAsync(1000);
    expect(handler).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(handler).toHaveBeenCalledTimes(2);

    consoleSpy.mockRestore();
  });

  it('should stop all tasks on shutdown', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);

    scheduler.registerInterval({
      name: 'testTask',
      intervalMs: 1000,
      handler,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(handler).toHaveBeenCalledTimes(1);

    scheduler.shutdown();

    await vi.advanceTimersByTimeAsync(5000);
    expect(handler).toHaveBeenCalledTimes(1); // No more calls
  });
});

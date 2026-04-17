import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Scheduler } from '../../src/scheduler/scheduler.js';

describe('Scheduler', () => {
  let scheduler: Scheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    scheduler = new Scheduler();
  });

  afterEach(() => {
    scheduler.shutdown();
    vi.useRealTimers();
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

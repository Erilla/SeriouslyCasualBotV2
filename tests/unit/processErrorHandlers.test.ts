import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { registerProcessErrorHandlers } from '../../src/processErrorHandlers.js';
import { logger } from '../../src/services/logger.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('registerProcessErrorHandlers', () => {
  it('logs unhandled promise rejections via logger.error', () => {
    const proc = new EventEmitter();
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => {});

    registerProcessErrorHandlers(proc);
    proc.emit('unhandledRejection', new Error('boom'));

    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0]).toBe('process');
    expect(spy.mock.calls[0][1]).toContain('boom');
  });

  it('logs uncaught exceptions via logger.error', () => {
    const proc = new EventEmitter();
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => {});

    registerProcessErrorHandlers(proc);
    proc.emit('uncaughtException', new Error('kaboom'));

    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0]).toBe('process');
    expect(spy.mock.calls[0][1]).toContain('kaboom');
  });

  it('coerces a non-Error rejection reason into a logged message', () => {
    const proc = new EventEmitter();
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => {});

    registerProcessErrorHandlers(proc);
    proc.emit('unhandledRejection', 'just a string');

    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][1]).toContain('just a string');
    // An Error object is passed through as the third argument for the stack trace.
    expect(spy.mock.calls[0][2]).toBeInstanceOf(Error);
  });
});

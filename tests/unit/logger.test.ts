import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger } from '../../src/services/logger.js';

describe('Logger', () => {
  let logger: Logger;

  beforeEach(() => {
    logger = new Logger('INFO');
  });

  it('should log INFO messages when level is INFO', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logger.info('raids', 'sync complete');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toContain('[INFO]');
    expect(spy.mock.calls[0][0]).toContain('[raids]');
    expect(spy.mock.calls[0][0]).toContain('sync complete');
    spy.mockRestore();
  });

  it('should not log DEBUG messages when level is INFO', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logger.debug('raids', 'debug detail');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('should log ERROR messages at any level', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logger.error('raids', 'something broke');
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('should allow changing log level at runtime', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logger.setLevel('DEBUG');
    logger.debug('raids', 'now visible');
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

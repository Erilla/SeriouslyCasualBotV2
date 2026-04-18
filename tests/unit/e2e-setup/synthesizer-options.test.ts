import { describe, it, expect } from 'vitest';
import { buildOptionsShim } from '../../../tests/e2e/setup/synthesizer.js';

describe('buildOptionsShim', () => {
  it('returns subcommand from the values map', () => {
    const opts = buildOptionsShim({ subcommand: 'seed_raiders', values: {} });
    expect(opts.getSubcommand()).toBe('seed_raiders');
  });

  it('throws when getSubcommand called without one set', () => {
    const opts = buildOptionsShim({ values: {} });
    expect(() => opts.getSubcommand()).toThrow(/no subcommand/i);
  });

  it('returns strings, ints, booleans', () => {
    const opts = buildOptionsShim({
      values: { name: 'foo', count: 3, discord: true },
    });
    expect(opts.getString('name')).toBe('foo');
    expect(opts.getInteger('count')).toBe(3);
    expect(opts.getBoolean('discord')).toBe(true);
  });

  it('returns null for missing non-required options', () => {
    const opts = buildOptionsShim({ values: {} });
    expect(opts.getString('missing')).toBeNull();
    expect(opts.getBoolean('missing')).toBeNull();
  });

  it('throws when required option is missing', () => {
    const opts = buildOptionsShim({ values: {} });
    expect(() => opts.getString('missing', true)).toThrow(/required option/i);
  });
});

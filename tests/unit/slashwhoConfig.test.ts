import { describe, it, expect } from 'vitest';
import { parseSlashWhoConfig } from '../../src/slashwhoConfig.js';

describe('parseSlashWhoConfig', () => {
  it('defaults to the legacy sweep, with the documented defaults', () => {
    expect(parseSlashWhoConfig({})).toEqual({
      intelEnabled: false,
      apiUrl: 'https://slashwho.com',
      botApiKey: '',
      pollIntervalMs: 5000,
      jobDeadlineMs: 600000,
      fallbackSweep: false,
    });
  });

  it('fails at startup when the flag is on without a key', () => {
    expect(() => parseSlashWhoConfig({ SLASHWHO_INTEL_ENABLED: 'true' })).toThrow(
      /SLASHWHO_BOT_API_KEY is not set/,
    );
    expect(() =>
      parseSlashWhoConfig({ SLASHWHO_INTEL_ENABLED: 'true', SLASHWHO_BOT_API_KEY: '  ' }),
    ).toThrow(/SLASHWHO_BOT_API_KEY/);
  });

  it('accepts the flag with a key, and strips a trailing slash from the URL', () => {
    const parsed = parseSlashWhoConfig({
      SLASHWHO_INTEL_ENABLED: 'true',
      SLASHWHO_BOT_API_KEY: 'key',
      SLASHWHO_API_URL: 'https://test.slashwho.com/',
      SLASHWHO_FALLBACK_SWEEP: 'true',
    });
    expect(parsed.intelEnabled).toBe(true);
    expect(parsed.apiUrl).toBe('https://test.slashwho.com');
    expect(parsed.fallbackSweep).toBe(true);
  });

  it('rejects a poll interval under a second, and a non-boolean flag', () => {
    expect(() => parseSlashWhoConfig({ SLASHWHO_POLL_INTERVAL_MS: '500' })).toThrow(
      /at least 1000/,
    );
    expect(() => parseSlashWhoConfig({ SLASHWHO_INTEL_ENABLED: 'yes' })).toThrow(/true or false/);
  });
});

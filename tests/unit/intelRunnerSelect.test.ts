import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Client } from 'discord.js';

vi.mock('../../src/functions/applications/intel/runJob.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runJob: vi.fn(async () => {}),
}));
vi.mock('../../src/functions/applications/intel/slashwhoJob.js', () => ({
  runSlashWhoJob: vi.fn(async () => {}),
}));

import { runJob } from '../../src/functions/applications/intel/runJob.js';
import { runSlashWhoJob } from '../../src/functions/applications/intel/slashwhoJob.js';
import { selectIntelRunner } from '../../src/functions/applications/intel/resumeJobs.js';
import { parseSlashWhoConfig } from '../../src/slashwhoConfig.js';

const client = {} as Client;

describe('selectIntelRunner', () => {
  beforeEach(() => vi.clearAllMocks());

  it('runs the legacy sweep, and never SlashWho, with the flag off', async () => {
    await selectIntelRunner(client, parseSlashWhoConfig({}))(7);
    expect(runJob).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ tierOrdinals: expect.any(Array) }),
    );
    expect(runSlashWhoJob).not.toHaveBeenCalled();
  });

  it('runs SlashWho with the flag on, with no fallback unless asked for', async () => {
    const settings = parseSlashWhoConfig({
      SLASHWHO_INTEL_ENABLED: 'true',
      SLASHWHO_BOT_API_KEY: 'key',
    });
    await selectIntelRunner(client, settings)(7);
    expect(runJob).not.toHaveBeenCalled();
    expect(runSlashWhoJob).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        dossierBaseUrl: 'https://slashwho.com',
        pollIntervalMs: 5000,
        deadlineMs: 600000,
        fallback: undefined,
      }),
    );
  });

  it('wires the legacy sweep as the fallback only when SLASHWHO_FALLBACK_SWEEP is on', async () => {
    const settings = parseSlashWhoConfig({
      SLASHWHO_INTEL_ENABLED: 'true',
      SLASHWHO_BOT_API_KEY: 'key',
      SLASHWHO_FALLBACK_SWEEP: 'true',
    });
    await selectIntelRunner(client, settings)(7);
    const { fallback } = vi.mocked(runSlashWhoJob).mock.calls[0][1];
    await fallback!(7);
    expect(runJob).toHaveBeenCalledWith(7, expect.anything());
  });
});

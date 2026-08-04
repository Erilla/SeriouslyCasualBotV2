import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { closeDatabase, getDatabase } from '../../src/database/db.js';
import { createTables } from '../../src/database/schema.js';

vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  createJob,
  addFinding,
  getFindings,
  type IntelFinding,
} from '../../src/functions/applications/intel/jobStore.js';
import {
  confirmDiscord,
  type ConfirmDeps,
} from '../../src/functions/applications/alts/confirmDiscord.js';

const applicant = { region: 'eu', realm: 'draenor', name: 'Regnipaw' };

const finding = (name: string, over: Partial<IntelFinding> = {}): IntelFinding => ({
  name,
  realm: 'Draenor',
  className: 'Monk',
  guildName: 'Rancour',
  guildRealm: 'Draenor',
  source: 'fingerprint',
  confidence: 93,
  discordStatus: null,
  discordProfile: null,
  ...over,
});

function deps(handles: Record<string, string | null>): ConfirmDeps {
  return {
    getCharacterOwner: vi.fn(async (c) => ({
      user: null,
      discordProfile: handles[c.name] ?? null,
      declaredMain: null,
    })),
    paceMs: 0,
  };
}

describe('confirmDiscord', () => {
  let jobId: number;
  beforeEach(() => {
    createTables(getDatabase(':memory:'));
    jobId = createJob({ applicationId: 1, targetChannelId: 'c', character: applicant });
  });
  afterEach(() => closeDatabase());

  it('confirms a character whose Discord handle matches, case-insensitively', async () => {
    addFinding(jobId, finding('Monkni'));
    const result = await confirmDiscord(jobId, 'eu', 'Binded', deps({ Monkni: 'binded' }));

    expect(result).toEqual({ confirmed: 1, mismatched: 0 });
    const stored = getFindings(jobId).find((f) => f.name === 'Monkni')!;
    expect(stored.discordStatus).toBe('confirmed');
    expect(stored.discordProfile).toBe('binded');
  });

  it('flags a mismatch and records the handle it saw', async () => {
    addFinding(jobId, finding('Someoneelse'));
    const result = await confirmDiscord(jobId, 'eu', 'binded', deps({ Someoneelse: 'notthem' }));

    expect(result).toEqual({ confirmed: 0, mismatched: 1 });
    const stored = getFindings(jobId).find((f) => f.name === 'Someoneelse')!;
    expect(stored.discordStatus).toBe('mismatch');
    expect(stored.discordProfile).toBe('notthem');
  });

  it('leaves the status unset when the character exposes no handle', async () => {
    addFinding(jobId, finding('Quiet'));
    await confirmDiscord(jobId, 'eu', 'binded', deps({ Quiet: null }));
    expect(getFindings(jobId).find((f) => f.name === 'Quiet')!.discordStatus).toBeNull();
  });

  it('skips characters the applicant named themselves', async () => {
    addFinding(jobId, finding('Regnipaw', { source: 'application', confidence: null }));
    const d = deps({ Regnipaw: 'binded' });
    await confirmDiscord(jobId, 'eu', 'binded', d);
    expect(d.getCharacterOwner).not.toHaveBeenCalled();
  });

  it('does nothing when the applicant Discord handle is unknown', async () => {
    addFinding(jobId, finding('Monkni'));
    const d = deps({ Monkni: 'binded' });
    const result = await confirmDiscord(jobId, 'eu', null, d);

    expect(result).toEqual({ confirmed: 0, mismatched: 0 });
    expect(d.getCharacterOwner).not.toHaveBeenCalled();
  });

  it('keeps going when one lookup throws', async () => {
    addFinding(jobId, finding('Broken'));
    addFinding(jobId, finding('Fine'));
    const getCharacterOwner = vi.fn(async (c: { name: string }) => {
      if (c.name === 'Broken') throw new Error('boom');
      return { user: null, discordProfile: 'binded', declaredMain: null };
    });

    const result = await confirmDiscord(jobId, 'eu', 'binded', {
      getCharacterOwner: getCharacterOwner as ConfirmDeps['getCharacterOwner'],
      paceMs: 0,
    });

    expect(result.confirmed).toBe(1);
    expect(getFindings(jobId).find((f) => f.name === 'Broken')!.discordStatus).toBeNull();
  });
});

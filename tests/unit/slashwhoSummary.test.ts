import { describe, it, expect } from 'vitest';
import {
  MAX_CHARACTER_LINES,
  mirrorFindings,
  mirrorGuildHistory,
  renderPointer,
  renderSlashWhoSummary,
} from '../../src/functions/applications/intel/slashwhoSummary.js';
import type { DossierCharacter, DossierSummary } from '../../src/services/slashwho.js';
import type { IntelFinding } from '../../src/functions/applications/intel/jobStore.js';

const key = (name: string, realm = 'argent-dawn') => ({ region: 'eu', realm, name });

const character = (over: Partial<DossierCharacter> & { name: string }): DossierCharacter => ({
  key: key(over.name.toLowerCase(), over.key?.realm),
  displayName: over.name,
  className: 'Warrior',
  guild: { name: 'Stormchasers', region: 'eu', realm: 'argent-dawn' },
  source: 'submitted',
  confidence: null,
  evidenceState: 'complete',
  pending: false,
  ...over,
});

function makeSummary(over: Partial<DossierSummary> = {}): DossierSummary {
  return {
    root: key('ragedoom'),
    state: 'ready',
    snapshotId: '13af3173-e97c-4c78-a6cb-a54b647b209f',
    lastCollectedAt: '2026-10-22T09:45:52.977Z',
    cuttingEdgesRestored: true,
    characters: [character({ name: 'Ragedoom' })],
    guildHistory: [
      {
        guild: { name: 'Stormchasers', region: 'eu', realm: 'argent-dawn' },
        firstNight: '2026-03-01',
        lastNight: '2026-10-09',
        raidNights: 40,
        tiers: ['Manaforge Omega'],
        characters: ['eu/argent-dawn/ragedoom'],
        raids: [
          {
            raidName: 'Manaforge Omega',
            kills: 8,
            firstKillAt: '2026-03-05T19:00:00.000Z',
            lastKillAt: '2026-10-09T21:00:00.000Z',
            characters: ['eu/argent-dawn/ragedoom'],
          },
        ],
      },
    ],
    raids: [
      {
        raidName: 'Manaforge Omega',
        bosses: [
          {
            bossName: 'Plexus Sentinel',
            state: 'kill',
            firstKilledAt: '2026-03-05T19:00:00.000Z',
            characters: ['eu/argent-dawn/ragedoom'],
            worldRank: 1724,
            reportUrl: null,
          },
          {
            bossName: 'Dimensius',
            state: 'wipe',
            firstKilledAt: null,
            characters: ['eu/argent-dawn/ragedoom'],
            worldRank: null,
            reportUrl: null,
          },
        ],
      },
    ],
    raidsTruncated: false,
    cuttingEdges: [
      { achievementName: 'Cutting Edge: Queen Ansurek', completedAt: '2025-01-01T00:00:00.000Z' },
    ],
    limitations: [],
    ...over,
  };
}

const finding = (over: Partial<IntelFinding>): IntelFinding => ({
  name: 'Ragedoom',
  realm: 'argent-dawn',
  className: 'Warrior',
  guildName: null,
  guildRealm: null,
  source: 'application',
  confidence: null,
  discordStatus: null,
  discordProfile: null,
  ...over,
});

describe('mirrorFindings', () => {
  const summary = makeSummary({
    characters: [
      character({ name: 'Ragedoom', source: 'submitted' }),
      character({ name: 'Rioalt', source: 'raiderio_declared' }),
      character({ name: 'Printalt', source: 'fingerprint_derived' }),
      character({ name: 'Officerlink', source: 'manually_added' }),
      character({ name: 'Botlink', source: 'submitted' }),
    ],
  });

  it('keeps the declared character as application, spelled as declared, and listed first', () => {
    const rows = mirrorFindings(
      summary,
      [{ region: 'eu', realm: 'Argent Dawn', name: 'ragedoom' }],
      [],
    );
    expect(rows[0]).toMatchObject({
      name: 'ragedoom',
      realm: 'argent-dawn',
      source: 'application',
      declared: true,
      guildName: 'Stormchasers',
    });
  });

  it('maps every SlashWho source onto the bot vocabulary', () => {
    const rows = mirrorFindings(
      summary,
      [{ region: 'eu', realm: 'argent-dawn', name: 'Ragedoom' }],
      [],
    );
    const by = Object.fromEntries(rows.map((r) => [r.name, [r.source, r.confidence]]));
    expect(by).toEqual({
      Ragedoom: ['application', null],
      Rioalt: ['raider.io', 100],
      // SlashWho has no score: carried as null, never invented.
      Printalt: ['fingerprint', null],
      Officerlink: ['linked', null],
      // A submitted character this job did not declare is not the applicant's own.
      Botlink: ['linked', null],
    });
  });

  it('spells a linked character the way the thread linked it', () => {
    const rows = mirrorFindings(
      summary,
      [],
      [{ region: 'eu', realm: 'argent-dawn', name: 'OfficerLink' }],
    );
    expect(rows.find((r) => r.name.toLowerCase() === 'officerlink')?.name).toBe('OfficerLink');
  });
});

describe('mirrorGuildHistory', () => {
  it('maps guild spans to stored stints with display names', () => {
    expect(mirrorGuildHistory(makeSummary())).toEqual([
      {
        guildName: 'Stormchasers',
        guildRealm: 'argent-dawn',
        stints: [
          {
            raidName: 'Manaforge Omega',
            kills: 8,
            first: '2026-03-05T19:00:00.000Z',
            last: '2026-10-09T21:00:00.000Z',
            characters: ['Ragedoom'],
          },
        ],
      },
    ]);
  });
});

describe('renderSlashWhoSummary', () => {
  const base = {
    applicantName: 'Ragedoom',
    region: 'eu',
    findings: [finding({})],
    dossierUrl: 'https://slashwho.com/dossiers/eu/argent-dawn/ragedoom',
  };

  it('shows characters, recent guild, progression, CE and the dossier link', () => {
    const body = renderSlashWhoSummary({ ...base, summary: makeSummary(), outcome: 'published' });
    expect(body).toContain(
      '[Open the full SlashWho dossier](https://slashwho.com/dossiers/eu/argent-dawn/ragedoom)',
    );
    expect(body).toContain('**Characters** — 1');
    expect(body).toContain('Stormchasers');
    expect(body).toContain('most recent');
    expect(body).toContain('1 boss killed · wiping on Dimensius · best world rank #1,724');
    expect(body).toContain('**Cutting Edge** — 1 (Queen Ansurek)');
    expect(body).not.toContain('searching');
    expect(body).not.toContain('Partial');
  });

  it('notes a partial dossier and lists its limitations', () => {
    const body = renderSlashWhoSummary({
      ...base,
      outcome: 'published',
      summary: makeSummary({
        state: 'partial',
        limitations: [
          { code: 'private', affects: 'kill_history', character: key('ragedoom') },
          { code: 'private', affects: 'kill_history', character: key('ragedoom') },
          { code: 'brand_new_code', affects: 'parses', character: null },
        ],
      }),
    });
    expect(body).toContain('*Partial');
    expect(body).toContain('· Ragedoom: profile is private — affects kill history');
    expect(body).toContain('· brand new code — affects parses');
    // Duplicates collapse to one line.
    expect(body.match(/profile is private/g)).toHaveLength(1);
  });

  it('never states "no Cutting Edge" when SlashWho could not restore it', () => {
    const body = renderSlashWhoSummary({
      ...base,
      outcome: 'published',
      summary: makeSummary({ cuttingEdges: [], cuttingEdgesRestored: false }),
    });
    expect(body).toContain('none found yet');
    expect(body).toContain('there may be more');
  });

  it('caps the character list and points at the dossier for the rest', () => {
    const many = Array.from({ length: MAX_CHARACTER_LINES + 3 }, (_, i) =>
      finding({ name: `Alt${i}`, source: 'fingerprint', confidence: null }),
    );
    const body = renderSlashWhoSummary({
      ...base,
      findings: many,
      summary: makeSummary(),
      outcome: 'published',
    });
    expect(body).toContain('…and 3 more in the dossier.');
    expect(body).not.toContain('100%');
    expect(body.length).toBeLessThanOrEqual(4096);
  });

  it('says honestly when the deadline passed while collecting', () => {
    const body = renderSlashWhoSummary({
      ...base,
      outcome: 'deadline',
      deadlineMs: 600_000,
      summary: makeSummary({ state: 'collecting', snapshotId: null, raids: [], guildHistory: [] }),
    });
    expect(body).toContain('Still collecting after 10 minutes');
    expect(body).toContain('No Mythic kills recorded yet.');
  });

  it('publishes research-unavailable copy with the declared characters only', () => {
    const body = renderSlashWhoSummary({
      ...base,
      outcome: 'unavailable',
      reason: 'it could not be reached',
      summary: null,
      dossierUrl: null,
    });
    expect(body).toContain('**Applicant research unavailable**');
    expect(body).toContain('it could not be reached');
    expect(body).not.toContain('Guilds');
  });
});

describe('renderPointer', () => {
  it('points the guild and log positions at the summary, never "searching…"', () => {
    for (const outcome of ['published', 'deadline', 'unavailable', 'abandoned'] as const) {
      for (const kind of ['guilds', 'logs'] as const) {
        const body = renderPointer(kind, outcome, 'https://sw/d');
        expect(body).not.toMatch(/searching|fetching/);
      }
    }
    expect(renderPointer('guilds', 'published', 'https://sw/d')).toContain(
      '[full dossier](https://sw/d)',
    );
  });
});

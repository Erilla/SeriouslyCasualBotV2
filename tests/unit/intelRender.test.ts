import { describe, it, expect } from 'vitest';
import {
  renderFooter,
  renderFoundCharacters,
  renderMythicLogs,
  renderGuildHistory,
  raiderIoProfileUrl,
  raiderIoGuildUrl,
} from '../../src/functions/applications/intel/render.js';
import type { IntelFinding } from '../../src/functions/applications/intel/jobStore.js';
import type { WclZone } from '../../src/functions/applications/mythic-logs/zoneCatalogue.js';
import type { BossEvidence } from '../../src/functions/applications/mythic-logs/selectMythicReports.js';

const finding = (over: Partial<IntelFinding>): IntelFinding => ({
  name: 'Monkni',
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

describe('raiderIoProfileUrl', () => {
  it('lowercases and hyphenates the realm but preserves the name', () => {
    expect(raiderIoProfileUrl('eu', 'Tarren Mill', 'Boptinus')).toBe(
      'https://raider.io/characters/eu/tarren-mill/Boptinus',
    );
  });
});

describe('raiderIoGuildUrl', () => {
  it('builds a guild URL from region, realm slug and name', () => {
    expect(raiderIoGuildUrl('eu', 'Silvermoon', 'SeriouslyCasual')).toBe(
      'https://raider.io/guilds/eu/silvermoon/SeriouslyCasual',
    );
  });

  it('percent-encodes a guild name containing spaces', () => {
    expect(raiderIoGuildUrl('eu', 'Silvermoon', 'Seriously Casual')).toBe(
      'https://raider.io/guilds/eu/silvermoon/Seriously%20Casual',
    );
  });
});

describe('renderFoundCharacters', () => {
  it('sorts the application character first, then by descending confidence', () => {
    const pages = renderFoundCharacters(
      [
        finding({ name: 'Regnie', confidence: 73 }),
        finding({ name: 'Monkni', confidence: 93 }),
        finding({ name: 'Regnipaw', source: 'application', confidence: null }),
      ],
      'Regnipaw',
      'eu',
    );
    const lines = pages[0].split('\n').filter((l) => l.startsWith('['));
    expect(lines[0]).toContain('Regnipaw');
    expect(lines[0]).toContain('from the application');
    expect(lines[1]).toContain('Monkni');
    expect(lines[2]).toContain('Regnie');
  });

  it('labels non-application characters undeclared with a confidence', () => {
    const pages = renderFoundCharacters([finding({})], 'Regnipaw', 'eu');
    expect(pages[0]).toContain('undeclared (93% confidence)');
  });

  it('appends the Discord verdict when the handle was confirmed', () => {
    const pages = renderFoundCharacters(
      [finding({ discordStatus: 'confirmed', discordProfile: 'binded' })],
      'Regnipaw',
      'eu',
    );
    expect(pages[0]).toContain('undeclared (93% confidence · Discord verified)');
  });

  it('shows the contradicting handle on a mismatch rather than hiding the character', () => {
    const pages = renderFoundCharacters(
      [finding({ discordStatus: 'mismatch', discordProfile: 'notthem' })],
      'Regnipaw',
      'eu',
    );
    expect(pages[0]).toContain('⚠ Discord mismatch: notthem');
    expect(pages[0]).toContain('Monkni');
  });

  it('links the name to Raider.IO and shows class and guild inline', () => {
    const pages = renderFoundCharacters([finding({})], 'Regnipaw', 'eu');
    expect(pages[0]).toContain('[Monkni-Draenor](https://raider.io/characters/eu/draenor/Monkni)');
    expect(pages[0]).toContain('Monk');
    expect(pages[0]).toContain('Rancour (Draenor)');
  });

  it('says so explicitly when nothing was found', () => {
    expect(renderFoundCharacters([], 'Regnipaw', 'eu')[0]).toContain('No other characters found');
  });

  it('pages when the list exceeds the embed description limit', () => {
    const many = Array.from({ length: 80 }, (_, i) => finding({ name: `Alt${i}`, confidence: 50 }));
    const pages = renderFoundCharacters(many, 'Regnipaw', 'eu');
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) expect(page.length).toBeLessThanOrEqual(4096);
  });

  it('appends the footer to the first page', () => {
    const pages = renderFoundCharacters([finding({})], 'Regnipaw', 'eu', {
      service: 'blizzard',
      scanned: 1240,
      total: 3000,
      retryAt: new Date(1785325500000),
    });
    expect(pages[0]).toContain('Rate limited on blizzard');
  });
});

describe('renderMythicLogs', () => {
  const zone: WclZone = {
    id: 46,
    name: 'VS / DR / MQD',
    expansion: 'Midnight',
    encounters: Array.from({ length: 9 }, (_, i) => ({ id: 3170 + i, name: `Boss ${i + 1}` })),
  };

  const kill: BossEvidence = {
    encounterId: 3177,
    bossIndex: 7,
    bossName: "Belo'ren, Child of Al'ar",
    who: 'Brenthunter',
    kind: 'kill',
    date: '2026-05-03T19:45:00.000Z',
    reportCode: 'bgDj26pmAHBdhPk3',
    isApplicantCharacter: false,
  };

  const wipe: BossEvidence = {
    encounterId: 3178,
    bossIndex: 8,
    bossName: 'Midnight Falls',
    who: 'Brentprietwo',
    kind: 'wipe',
    percent: 80.52,
    reportCode: '1rkzLm8jK9x3YCwc',
    isApplicantCharacter: false,
  };

  it('renders kills with a Discord-formatted first-kill date and the character', () => {
    const out = renderMythicLogs('Brentpriest', [{ zone, lines: [kill] }], 4);
    const stamp = `<t:${Math.floor(new Date(kill.date!).getTime() / 1000)}:D>`;
    expect(out).toContain(`8/9 **Belo'ren, Child of Al'ar** — first kill ${stamp}`);
    expect(out).toContain('**Brenthunter**');
    expect(out).toContain('[report](https://www.warcraftlogs.com/reports/bgDj26pmAHBdhPk3)');
  });

  it('renders wipes with the best percentage instead of a date', () => {
    const out = renderMythicLogs('Brentpriest', [{ zone, lines: [wipe] }], 4);
    expect(out).toContain('9/9 **Midnight Falls** — wiping, best 80.5%');
    expect(out).not.toContain('first kill');
  });

  it('heads each tier with its zone and expansion', () => {
    const out = renderMythicLogs('Brentpriest', [{ zone, lines: [kill] }], 4);
    expect(out).toContain('**VS / DR / MQD** *(Midnight)*');
  });

  it('omits the date when the kill date is unknown', () => {
    const out = renderMythicLogs(
      'Brentpriest',
      [{ zone, lines: [{ ...kill, date: undefined }] }],
      4,
    );
    expect(out).toContain('killed');
    expect(out).not.toContain('first kill undefined');
  });

  it('states the empty case explicitly', () => {
    expect(renderMythicLogs('Brentpriest', [], 0)).toContain('No Mythic raid logs found');
  });
});

describe('renderGuildHistory', () => {
  const FIRST = '2026-04-23T19:00:00.000Z';
  const LAST = '2026-07-16T20:30:00.000Z';
  const ONE_DAY = '2024-12-27T21:00:00.000Z';
  const stamp = (iso: string) => `<t:${Math.floor(new Date(iso).getTime() / 1000)}:D>`;

  const entries = [
    {
      guildName: 'Hindsight',
      guildRealm: 'Kazzak',
      stints: [
        {
          raidName: 'VS / DR / MQD',
          kills: 120,
          first: FIRST,
          last: LAST,
          characters: ['Dödsleif', 'Dödslock'],
        },
      ],
    },
    {
      guildName: 'WashedUp',
      guildRealm: 'Twisting Nether',
      stints: [
        {
          raidName: 'Nerub-ar Palace',
          kills: 1,
          first: ONE_DAY,
          last: ONE_DAY,
          characters: ['Dödsleif'],
        },
      ],
    },
  ];

  it('links the guild name to its Raider.IO page', () => {
    const pages = renderGuildHistory(entries, 'eu');
    expect(pages[0]).toContain('**[Hindsight](https://raider.io/guilds/eu/kazzak/Hindsight)**');
  });

  it('hyphenates a multi-word realm in the guild link', () => {
    const pages = renderGuildHistory(entries, 'eu');
    expect(pages[0]).toContain('https://raider.io/guilds/eu/twisting-nether/WashedUp');
  });

  it('heads each guild with its realm and overall span as Discord timestamps', () => {
    const pages = renderGuildHistory(entries, 'eu');
    expect(pages[0]).toContain(`*(Kazzak)* — ${stamp(FIRST)} → ${stamp(LAST)}`);
  });

  it('lists a line per raid with kills, dates and characters', () => {
    const pages = renderGuildHistory(entries, 'eu');
    expect(pages[0]).toContain(
      `VS / DR / MQD · 120 Mythic kills · ${stamp(FIRST)} → ${stamp(LAST)}`,
    );
    expect(pages[0]).toContain('Dödsleif, Dödslock');
  });

  it('collapses a single-day span to one timestamp and singularises one kill', () => {
    const pages = renderGuildHistory(entries, 'eu');
    expect(pages[0]).toContain(`Nerub-ar Palace · 1 Mythic kill · ${stamp(ONE_DAY)} ·`);
    expect(pages[0]).not.toContain(`${stamp(ONE_DAY)} → ${stamp(ONE_DAY)}`);
  });

  it('counts the guilds in the heading', () => {
    const pages = renderGuildHistory(entries, 'eu');
    expect(pages[0]).toContain('**Guild history** — 2 guilds');
  });

  it('states the empty case explicitly', () => {
    expect(renderGuildHistory([], 'eu')[0]).toContain('No guild history found');
  });

  it('appends the footer to the first page', () => {
    const pages = renderGuildHistory(entries, 'eu', {
      service: 'raiderio-internal',
      scanned: 10,
      total: 3000,
      retryAt: new Date(1785325500000),
    });
    expect(pages[0]).toContain('Rate limited on raiderio-internal');
  });

  it('every page fits within the embed description limit', () => {
    const pages = renderGuildHistory(entries, 'eu');
    for (const page of pages) expect(page.length).toBeLessThanOrEqual(4096);
  });

  it('pages when the guild history exceeds the embed description limit', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      guildName: `Guild${i}`,
      guildRealm: 'Kazzak',
      stints: [
        {
          raidName: 'VS / DR / MQD',
          kills: 120,
          first: FIRST,
          last: LAST,
          characters: ['Dödsleif', 'Dödslock'],
        },
      ],
    }));
    const pages = renderGuildHistory(many, 'eu');
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) expect(page.length).toBeLessThanOrEqual(4096);
  });

  it('never splits a guild block across a page boundary', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      guildName: `Guild${i}`,
      guildRealm: 'Kazzak',
      stints: [
        {
          raidName: 'VS / DR / MQD',
          kills: 120,
          first: FIRST,
          last: LAST,
          characters: ['Dödsleif', 'Dödslock'],
        },
      ],
    }));
    const pages = renderGuildHistory(many, 'eu');
    for (let i = 0; i < many.length; i++) {
      const head = `**[Guild${i}](`;
      const raidLine = 'VS / DR / MQD · 120 Mythic kills';
      const page = pages.find((p) => p.includes(head));
      expect(page).toBeDefined();
      expect(page).toContain(raidLine);
    }
  });
});

describe('renderFooter', () => {
  it('names the service, the progress and the retry as a relative timestamp', () => {
    const footer = renderFooter({
      service: 'blizzard',
      scanned: 1240,
      total: 3000,
      retryAt: new Date(1785325500000),
    });
    expect(footer).toContain('Rate limited on blizzard');
    expect(footer).toContain('1,240 of ~3,000');
    expect(footer).toContain('<t:1785325500:R>');
  });

  it('renders a terminal footer with no retry when abandoned', () => {
    const footer = renderFooter({
      service: 'blizzard',
      scanned: 1240,
      total: 3000,
      abandoned: true,
    });
    expect(footer).toContain('Incomplete');
    expect(footer).not.toContain('<t:');
  });
});

describe('realm slugs render as readable names', () => {
  /**
   * Findings store the realm slug-normalised, because the findings table's
   * primary key is case-sensitive and Blizzard rosters yield slugs while
   * Raider.IO yields display names — without one canonical form the same
   * character inserts twice. That is right for storage but reads badly, so the
   * renderer restores a display form. URLs must keep using the slug.
   */
  it('title-cases a single-word slug', () => {
    const pages = renderFoundCharacters([finding({ realm: 'darksorrow' })], 'Regnipaw', 'eu');
    expect(pages[0]).toContain('Monkni-Darksorrow');
    expect(pages[0]).toContain('https://raider.io/characters/eu/darksorrow/Monkni');
  });

  it('turns a hyphenated slug into spaced words', () => {
    const pages = renderFoundCharacters(
      [finding({ realm: 'argent-dawn', guildRealm: 'twisting-nether' })],
      'Regnipaw',
      'eu',
    );
    expect(pages[0]).toContain('Monkni-Argent Dawn');
    expect(pages[0]).toContain('(Twisting Nether)');
    expect(pages[0]).toContain('https://raider.io/characters/eu/argent-dawn/Monkni');
  });

  it('leaves an already-readable realm untouched', () => {
    const pages = renderFoundCharacters([finding({ realm: 'Tarren Mill' })], 'Regnipaw', 'eu');
    expect(pages[0]).toContain('Monkni-Tarren Mill');
  });

  it('renders the guild-history realm readably', () => {
    const out = renderGuildHistory(
      [
        {
          guildName: 'Rewritten',
          guildRealm: 'twisting-nether',
          stints: [
            {
              raidName: 'Manaforge Omega',
              kills: 1,
              first: '2025-11-16T19:56:47.000Z',
              last: '2025-11-16T19:56:47.000Z',
              characters: ['Exya'],
            },
          ],
        },
      ],
      'eu',
    );
    expect(out[0]).toContain('*(Twisting Nether)*');
    expect(out[0]).toContain('https://raider.io/guilds/eu/twisting-nether/Rewritten');
  });
});

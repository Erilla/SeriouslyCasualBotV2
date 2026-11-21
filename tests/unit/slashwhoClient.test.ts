import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  createSlashWhoClient,
  dossierPageUrl,
  parseSummary,
  SlashWhoContractError,
  type SlashWhoTransport,
} from '../../src/services/slashwho.js';

/** SlashWho's own recorded contract (Erilla/SlashWho tests/fixtures/contracts, PR #917). */
const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/slashwho/bot-client-v1.json', import.meta.url), 'utf8'),
) as Record<string, { response: unknown; request?: unknown }>;

const root = { region: 'eu', realm: 'silvermoon', name: 'ryii' };

function fakeTransport(response: unknown) {
  return vi.fn<SlashWhoTransport>(async () => response);
}

describe('SlashWho client', () => {
  it('creates one dossier from every character URL, with the bearer key', async () => {
    const transport = fakeTransport(fixture.create.response);
    const client = createSlashWhoClient({ baseUrl: 'https://sw.test', apiKey: 'k', transport });
    const urls = (fixture.create.request as { characters: string[] }).characters;

    const result = await client.ensureDossier(urls);

    expect(transport).toHaveBeenCalledTimes(1);
    const [url, init] = transport.mock.calls[0];
    expect(url).toBe('https://sw.test/api/v1/dossiers');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer k');
    expect(JSON.parse(init.body as string)).toEqual({ characters: urls });
    expect(result.root).toEqual(root);
    expect(result.outcomes.map((o) => o.outcome)).toEqual(['queued', 'existing']);
  });

  it('reads status, summary, add-character and refresh at their v1 paths', async () => {
    const transport = vi.fn<SlashWhoTransport>(async (url) => {
      if (url.endsWith('/status')) return fixture.status.response;
      if (url.endsWith('/characters')) return fixture.addCharacter.response;
      if (url.endsWith('/refresh')) return fixture.refresh.response;
      return fixture.summary.response;
    });
    const client = createSlashWhoClient({ baseUrl: 'https://sw.test', apiKey: 'k', transport });

    expect((await client.getStatus(root)).state).toBe('ready');
    const summary = await client.getDossier(root);
    expect(summary.characters[0].displayName).toBe('Ryii');
    expect(summary.characters[0].confidence).toBeNull();
    expect(await client.addDossierCharacter(root, 'https://raider.io/characters/eu/x/y')).toEqual(
      fixture.addCharacter.response,
    );
    expect((await client.refreshDossier(root)).mode).toBe('full');

    expect(transport.mock.calls.map(([url, init]) => `${init.method} ${url}`)).toEqual([
      'GET https://sw.test/api/v1/dossiers/eu/silvermoon/ryii/status',
      'GET https://sw.test/api/v1/dossiers/eu/silvermoon/ryii',
      'POST https://sw.test/api/v1/dossiers/eu/silvermoon/ryii/characters',
      'POST https://sw.test/api/v1/dossiers/eu/silvermoon/ryii/refresh',
    ]);
  });

  it('ignores fields SlashWho adds later', () => {
    const body = {
      ...(fixture.summary.response as object),
      somethingNew: { nested: true },
    };
    expect(() => parseSummary(body)).not.toThrow();
  });

  it('fails loudly, naming the path, when a field changes shape', () => {
    const body = structuredClone(fixture.summary.response) as {
      characters: { source: string }[];
    };
    body.characters[0].source = 'telepathy';
    expect(() => parseSummary(body)).toThrow(SlashWhoContractError);
    expect(() => parseSummary(body)).toThrow(/characters\[0\]\.source/);
  });

  it('builds the dossier page link, not the /characters path that 404s', () => {
    expect(
      dossierPageUrl('https://slashwho.com', {
        region: 'EU',
        realm: 'argent-dawn',
        name: 'Ragedoom',
      }),
    ).toBe('https://slashwho.com/dossiers/eu/argent-dawn/ragedoom');
  });
});

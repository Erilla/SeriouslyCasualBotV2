import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { parseV1Export } from '../../../src/functions/migrate/parseV1Export.js';

function makeV1Db(): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE keyv (key TEXT PRIMARY KEY, value TEXT)');
  const put = (key: string, payload: unknown) =>
    db
      .prepare('INSERT INTO keyv (key, value) VALUES (?, ?)')
      .run(key, JSON.stringify({ value: payload, expires: null }));
  put('raiders:Eldrítch', '230118286229110784');
  put('overlords:Bing', '111111111111111111');
  // ignoredCharacters entries have NO `value` field in V1 — only `{expires:null}`.
  db.prepare('INSERT INTO keyv (key, value) VALUES (?, ?)').run(
    'ignoredCharacters:Ryann',
    JSON.stringify({ expires: null }),
  );
  put('lootResponses:197140', {
    major: ['u1', 'u2'],
    minor: ['u3'],
    wantIn: [],
    wantOut: ['u4'],
    bossName: 'Midnight Falls',
    bossUrl: 'https://x/mf',
    channelId: 'c',
    messageId: 'm',
  });
  // Old-tier boss must be filtered out.
  put('lootResponses:184972', {
    major: ['u9'],
    minor: [],
    wantIn: [],
    wantOut: [],
    bossName: 'Eranog',
    bossUrl: 'https://x/er',
    channelId: 'c',
    messageId: 'm',
  });
  return db;
}

describe('parseV1Export', () => {
  it('decodes identity map, overlords, ignored, and current-tier loot only', () => {
    const result = parseV1Export(makeV1Db());

    expect(result.identityMap).toEqual([
      { characterName: 'Eldrítch', discordUserId: '230118286229110784' },
    ]);
    expect(result.overlords).toEqual([{ name: 'Bing', userId: '111111111111111111' }]);
    expect(result.ignored).toEqual(['Ryann']);

    expect(result.lootPosts).toHaveLength(1);
    expect(result.lootPosts[0]).toEqual({
      bossId: 197140,
      bossName: 'Midnight Falls',
      bossUrl: 'https://x/mf',
      votes: { major: ['u1', 'u2'], minor: ['u3'], wantIn: [], wantOut: ['u4'] },
    });
  });

  it('skips a corrupt keyv row without throwing', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE keyv (key TEXT PRIMARY KEY, value TEXT)');
    // Insert corrupt JSON in a raiders entry
    db.prepare('INSERT INTO keyv (key, value) VALUES (?, ?)').run(
      'raiders:Broken',
      'this is not json',
    );
    // Insert a valid raiders entry
    db.prepare('INSERT INTO keyv (key, value) VALUES (?, ?)').run(
      'raiders:Valid',
      JSON.stringify({ value: '987654321098765432', expires: null }),
    );

    // Should not throw and should parse only the valid entry
    const result = parseV1Export(db);
    expect(result.identityMap).toEqual([
      { characterName: 'Valid', discordUserId: '987654321098765432' },
    ]);
  });

  it('ignores a lootResponses key with an empty boss-id suffix', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE keyv (key TEXT PRIMARY KEY, value TEXT)');
    // Insert a lootResponses entry with empty suffix (which would convert to 0)
    db.prepare('INSERT INTO keyv (key, value) VALUES (?, ?)').run(
      'lootResponses:',
      JSON.stringify({
        value: {
          major: ['u1'],
          minor: [],
          wantIn: [],
          wantOut: [],
          bossName: 'Fake Boss',
          bossUrl: null,
          channelId: 'c',
          messageId: 'm',
        },
        expires: null,
      }),
    );

    const result = parseV1Export(db);
    // Should not contain any loot posts (bossId 0 should be filtered)
    expect(result.lootPosts).toHaveLength(0);
  });
});

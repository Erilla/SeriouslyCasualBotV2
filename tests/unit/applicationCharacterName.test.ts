import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Message, User } from 'discord.js';
import { closeDatabase, getDatabase } from '../../src/database/db.js';
import { createTables } from '../../src/database/schema.js';
import {
  parseRaiderIoCharacter,
  collectRaiderIoCharacters,
} from '../../src/functions/applications/raiderIoName.js';

vi.mock('../../src/services/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { startApplication } from '../../src/functions/applications/startApplication.js';
import {
  handleDmMessage,
  activeSessions,
} from '../../src/functions/applications/dmQuestionnaire.js';
import type { ApplicationRow } from '../../src/types/index.js';

/** Minimal User stand-in for the DM questionnaire flow. */
function fakeUser(id: string, displayName: string): User {
  return {
    id,
    displayName,
    tag: `${displayName}#0001`,
    send: vi.fn().mockResolvedValue(undefined),
  } as unknown as User;
}

/** Minimal DM Message stand-in carrying an applicant's answer. */
function fakeDm(author: User, content: string): Message {
  return { author, content } as unknown as Message;
}

describe('application character_name source', () => {
  beforeEach(() => {
    closeDatabase();
    const db = getDatabase(':memory:');
    createTables(db);
    // The first question asks for class — NOT the character name. This mirrors
    // the seeded default question set that triggered the bug.
    db.prepare('INSERT INTO application_questions (question, sort_order) VALUES (?, ?)').run(
      'What class and spec are you applying as?',
      1,
    );
    db.prepare('INSERT INTO application_questions (question, sort_order) VALUES (?, ?)').run(
      'Please link your Raider.IO profile',
      2,
    );
  });

  afterEach(() => {
    activeSessions.clear();
    closeDatabase();
  });

  it('uses the Discord display name, not the first answer (e.g. class "DK")', async () => {
    const user = fakeUser('applicant-1', 'RyanW');

    await startApplication(user);

    // Answer the first question (class) and the second (raider.io).
    await handleDmMessage(fakeDm(user, 'DK'));
    await handleDmMessage(fakeDm(user, 'https://raider.io/characters/eu/silvermoon/ryanw'));

    const db = getDatabase();
    const app = db
      .prepare('SELECT * FROM applications WHERE applicant_user_id = ?')
      .get('applicant-1') as ApplicationRow;

    expect(app.character_name).toBe('RyanW');
    expect(app.character_name).not.toBe('DK');
  });
});

describe('parseRaiderIoCharacter', () => {
  it('returns region, realm and name', () => {
    expect(parseRaiderIoCharacter('https://raider.io/characters/eu/draenor/Brentpriest')).toEqual({
      region: 'eu',
      realm: 'draenor',
      name: 'Brentpriest',
    });
  });

  it('keeps multi-word realm slugs intact', () => {
    expect(parseRaiderIoCharacter('https://raider.io/characters/eu/argent-dawn/Driptinus')).toEqual(
      { region: 'eu', realm: 'argent-dawn', name: 'Driptinus' },
    );
  });

  it('decodes percent-encoded names', () => {
    expect(parseRaiderIoCharacter('https://raider.io/characters/eu/silvermoon/Sk%C3%A2di')).toEqual(
      { region: 'eu', realm: 'silvermoon', name: 'Skâdi' },
    );
  });

  it('returns null when there is no character URL', () => {
    expect(parseRaiderIoCharacter('I raid on Tuesdays')).toBeNull();
  });
});

describe('collectRaiderIoCharacters', () => {
  it('collects a character from every answer, in order', () => {
    const answers = [
      { answer: 'https://raider.io/characters/eu/draenor/Brentpriest' },
      { answer: 'my alt https://raider.io/characters/eu/draenor/Brenthunter too' },
    ];
    expect(collectRaiderIoCharacters(answers).map((c) => c.name)).toEqual([
      'Brentpriest',
      'Brenthunter',
    ]);
  });

  it('collects multiple characters from a single answer', () => {
    const answers = [
      {
        answer:
          'https://raider.io/characters/eu/draenor/Brentpriest and https://raider.io/characters/eu/draenor/Brenthunter',
      },
    ];
    expect(collectRaiderIoCharacters(answers)).toHaveLength(2);
  });

  it('deduplicates case-insensitively on realm and name', () => {
    const answers = [
      { answer: 'https://raider.io/characters/eu/draenor/Brentpriest' },
      { answer: 'https://raider.io/characters/EU/draenor/brentpriest' },
    ];
    expect(collectRaiderIoCharacters(answers)).toHaveLength(1);
  });

  it('returns an empty array when no answer contains a URL', () => {
    expect(collectRaiderIoCharacters([{ answer: 'none here' }])).toEqual([]);
  });
});

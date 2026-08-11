import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, getDatabase } from '../../src/database/db.js';
import { createTables } from '../../src/database/schema.js';

vi.mock('../../src/services/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { generateVotingEmbed } =
  await import('../../src/functions/applications/generateVotingEmbed.js');
const { intelRefreshRow } = await import('../../src/functions/applications/intel/placeholders.js');

beforeEach(() => {
  closeDatabase();
  createTables(getDatabase(':memory:'));
});

afterEach(() => {
  closeDatabase();
});

describe('intelRefreshRow', () => {
  it('labels the control for characters generally, not just linked ones', () => {
    const [button] = intelRefreshRow(7, 'done').components;
    expect(button.data).toMatchObject({ label: 'Refresh characters' });
  });

  it('still shows the in-flight label while a sweep is running', () => {
    const [button] = intelRefreshRow(7, 'running').components;
    expect(button.data).toMatchObject({ label: 'Refreshing…', disabled: true });
  });
});

describe('generateVotingEmbed', () => {
  const labels = (applicationId: number): (string | undefined)[] =>
    generateVotingEmbed(applicationId).components[0].components.map(
      (c) => (c.data as { label?: string }).label,
    );

  it('offers exactly For, Neutral and Against', () => {
    expect(labels(1)).toEqual(['For', 'Neutral', 'Against']);
  });

  it('puts no emoji on any vote button', () => {
    const buttons = generateVotingEmbed(1).components[0].components;
    for (const button of buttons) {
      expect((button.data as { emoji?: unknown }).emoji).toBeUndefined();
    }
  });

  it('has no Kekw field in the embed', () => {
    const { embeds } = generateVotingEmbed(1);
    const names = embeds[0].data.fields?.map((f) => f.name) ?? [];
    expect(names).toEqual(['For (0)', 'Neutral (0)', 'Against (0)', 'Progress']);
  });

  it('still counts the votes that remain', () => {
    const db = getDatabase();
    db.prepare(
      `INSERT INTO applications (id, applicant_user_id, status, character_name)
       VALUES (3, 'u1', 'active', 'Braene')`,
    ).run();
    for (const [user, type] of [
      ['u1', 'for'],
      ['u2', 'for'],
      ['u3', 'against'],
    ]) {
      db.prepare(
        'INSERT INTO application_votes (application_id, user_id, vote_type) VALUES (?, ?, ?)',
      ).run(3, user, type);
    }

    const names = generateVotingEmbed(3).embeds[0].data.fields?.map((f) => f.name) ?? [];
    expect(names).toContain('For (2)');
    expect(names).toContain('Against (1)');
  });

  describe('the tally line', () => {
    const seed = (applicationId: number, votes: [string, string][]): void => {
      const db = getDatabase();
      db.prepare(
        `INSERT INTO applications (id, applicant_user_id, status, character_name)
         VALUES (?, 'u1', 'active', 'Braene')`,
      ).run(applicationId);
      for (const [user, type] of votes) {
        db.prepare(
          'INSERT INTO application_votes (application_id, user_id, vote_type) VALUES (?, ?, ?)',
        ).run(applicationId, user, type);
      }
    };

    const tally = (applicationId: number): string =>
      generateVotingEmbed(applicationId).embeds[0].data.fields?.find((f) => f.name === 'Progress')
        ?.value ?? '';

    it('marks one glyph per vote, for then neutral then against', () => {
      seed(10, [
        ['u1', 'for'],
        ['u2', 'against'],
        ['u3', 'for'],
        ['u4', 'neutral'],
      ]);
      expect(tally(10)).toContain('✅✅➖❌');
    });

    it('keeps the decisive count alongside the glyphs', () => {
      seed(11, [
        ['u1', 'for'],
        ['u2', 'for'],
        ['u3', 'against'],
      ]);
      expect(tally(11)).toContain('2/3');
    });

    it('uses no block-bar characters at all', () => {
      seed(12, [['u1', 'for']]);
      expect(tally(12)).not.toMatch(/[█░]/);
    });

    it('shows neutral votes rather than calling them no votes', () => {
      // The old bar counted only for-vs-against, so an application everyone
      // abstained on read as "No votes yet" — which is not what happened.
      seed(13, [
        ['u1', 'neutral'],
        ['u2', 'neutral'],
      ]);
      expect(tally(13)).toContain('➖➖');
      expect(tally(13)).not.toContain('No votes yet');
    });

    it('still says so when nobody has voted', () => {
      seed(14, []);
      expect(tally(14)).toBe('No votes yet');
    });
  });

  it('ignores a stale kekw vote rather than throwing', () => {
    // The button is gone, but its message is never deleted — a click on an old
    // embed can still write the row, and the embed must survive reading it.
    const db = getDatabase();
    db.prepare(
      `INSERT INTO applications (id, applicant_user_id, status, character_name)
       VALUES (4, 'u1', 'active', 'Braene')`,
    ).run();
    db.prepare(
      'INSERT INTO application_votes (application_id, user_id, vote_type) VALUES (?, ?, ?)',
    ).run(4, 'u9', 'kekw');

    const names = generateVotingEmbed(4).embeds[0].data.fields?.map((f) => f.name) ?? [];
    expect(names).toEqual(['For (0)', 'Neutral (0)', 'Against (0)', 'Progress']);
  });
});

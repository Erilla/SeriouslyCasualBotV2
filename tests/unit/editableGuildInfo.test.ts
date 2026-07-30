import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, getDatabase, initDatabase } from '../../src/database/db.js';
import {
  getAboutUs,
  getAchievementsTitle,
  getGuildInfoLink,
  getRecruitmentSection,
  getScheduleConfig,
  getScheduleDay,
  saveAboutUs,
  saveAchievementsTitle,
  saveGuildInfoLink,
  saveRecruitmentSection,
  saveScheduleConfig,
  saveScheduleDay,
  validateGuildInfoUrl,
} from '../../src/functions/guild-info/editableGuildInfo.js';

function contentRow(key: string) {
  return getDatabase()
    .prepare('SELECT key, title, content FROM guild_info_content WHERE key = ?')
    .get(key) as { key: string; title: string | null; content: string } | undefined;
}

beforeEach(() => {
  closeDatabase();
  initDatabase(':memory:');
});

afterEach(() => {
  closeDatabase();
});

describe('editable Guild Info persistence', () => {
  it('reads and updates the seeded About Us row without trimming Markdown', () => {
    expect(getAboutUs()).toMatchObject({ key: 'aboutus', title: 'About Us' });
    expect(saveAboutUs('  Updated About  ', '  **Raw Markdown**  ')).toBe(true);
    expect(getAboutUs()).toMatchObject({
      title: '  Updated About  ',
      content: '  **Raw Markdown**  ',
    });
  });

  it('updates only the selected seeded recruitment row', () => {
    expect(saveRecruitmentSection('want', 'Wanted', '**Be prepared.**')).toBe(true);
    expect(contentRow('recruitment_want')).toMatchObject({
      title: 'Wanted',
      content: '**Be prepared.**',
    });
    expect(contentRow('recruitment_give')!.content).toContain('stable mythic');
  });

  it('reads and retains the Contact placeholder literally', () => {
    expect(getRecruitmentSection('contact')?.content).toContain('{{OVERLORDS}}');
    expect(saveRecruitmentSection('contact', 'Contact', 'Contact {{OVERLORDS}}')).toBe(true);
    expect(getRecruitmentSection('contact')).toMatchObject({
      title: 'Contact',
      content: 'Contact {{OVERLORDS}}',
    });
  });

  it('reads and updates the seeded schedule config', () => {
    expect(getScheduleConfig()).toEqual({
      title: 'Raid Schedule',
      timezone: 'Server Time (CEST +1)',
    });
    expect(saveScheduleConfig('New Schedule', 'UTC')).toBe(true);
    expect(getScheduleConfig()).toEqual({ title: 'New Schedule', timezone: 'UTC' });
  });

  it('maps schedule choices to their fixed sort orders', () => {
    expect(getScheduleDay('wednesday')).toMatchObject({ day: 'Wednesday', sort_order: 1 });
    expect(saveScheduleDay('sunday', 'Sunday Funday', '19:00 - 22:00')).toBe(true);
    expect(getScheduleDay('sunday')).toMatchObject({
      day: 'Sunday Funday',
      time: '19:00 - 22:00',
      sort_order: 2,
    });
  });

  it('maps Warcraft Logs to the third link row by id order', () => {
    expect(getGuildInfoLink('warcraftlogs')?.label).toBe('Warcraft Logs');
  });

  it('reads and updates a seeded link while preserving its emoji', () => {
    const original = getGuildInfoLink('raiderio')!;
    expect(saveGuildInfoLink('raiderio', 'RIO', 'https://example.test/guild')).toBe(true);
    expect(getGuildInfoLink('raiderio')).toMatchObject({
      id: original.id,
      label: 'RIO',
      url: 'https://example.test/guild',
      emoji_id: original.emoji_id,
    });
  });

  it('reads and updates the achievements title', () => {
    expect(getAchievementsTitle()).toMatchObject({ key: 'achievements_title' });
    expect(saveAchievementsTitle('  Progress  ')).toBe(true);
    expect(getAchievementsTitle()).toMatchObject({ title: '  Progress  ' });
  });

  it('returns null or false instead of creating missing editable records', () => {
    const db = getDatabase();
    db.prepare('DELETE FROM guild_info_content WHERE key = ?').run('aboutus');
    db.prepare('DELETE FROM guild_info_content WHERE key = ?').run('recruitment_who');
    db.prepare('DELETE FROM schedule_config WHERE key = ?').run('timezone');
    db.prepare('DELETE FROM schedule_days WHERE sort_order = ?').run(2);
    db.prepare(
      'DELETE FROM guild_info_links WHERE id = (SELECT id FROM guild_info_links ORDER BY id LIMIT 1 OFFSET 2)',
    ).run();
    db.prepare('DELETE FROM guild_info_content WHERE key = ?').run('achievements_title');

    expect(getAboutUs()).toBeNull();
    expect(saveAboutUs('About', 'Body')).toBe(false);
    expect(getRecruitmentSection('who')).toBeNull();
    expect(saveRecruitmentSection('who', 'Who', 'Body')).toBe(false);
    expect(getScheduleConfig()).toBeNull();
    expect(saveScheduleConfig('Title', 'Timezone')).toBe(false);
    expect(getScheduleDay('sunday')).toBeNull();
    expect(saveScheduleDay('sunday', 'Sunday', '20:00')).toBe(false);
    expect(getGuildInfoLink('warcraftlogs')).toBeNull();
    expect(saveGuildInfoLink('warcraftlogs', 'Logs', 'https://example.test')).toBe(false);
    expect(getAchievementsTitle()).toBeNull();
    expect(saveAchievementsTitle('Progress')).toBe(false);
  });

  it.each([
    ['saveAboutUs', () => saveAboutUs('   ', 'Body')],
    ['saveAboutUs body', () => saveAboutUs('Title', '   ')],
    ['saveScheduleConfig', () => saveScheduleConfig('   ', 'UTC')],
    ['saveScheduleConfig timezone', () => saveScheduleConfig('Title', '   ')],
    ['saveScheduleDay', () => saveScheduleDay('wednesday', '   ', '20:00')],
    ['saveScheduleDay time', () => saveScheduleDay('wednesday', 'Wednesday', '   ')],
    ['saveRecruitmentSection', () => saveRecruitmentSection('who', '   ', 'Body')],
    ['saveRecruitmentSection body', () => saveRecruitmentSection('who', 'Who', '   ')],
    ['saveGuildInfoLink', () => saveGuildInfoLink('raiderio', '   ', 'https://example.test')],
    ['saveAchievementsTitle', () => saveAchievementsTitle('   ')],
  ])('rejects whitespace-only required text for %s', (_name, save) => {
    expect(save).toThrow(/required/i);
  });

  it.each(['mailto:officer@example.test', 'ftp://example.test', 'not a url'])(
    'rejects non-HTTP(S) links',
    (value) => {
      expect(() => validateGuildInfoUrl(value)).toThrow(/http or https/i);
    },
  );

  it('accepts HTTP(S) links and rejects an invalid link before writing', () => {
    expect(validateGuildInfoUrl('https://example.test/path')).toBe('https://example.test/path');
    expect(validateGuildInfoUrl('http://example.test')).toBe('http://example.test');
    expect(() => saveGuildInfoLink('raiderio', 'RIO', 'ftp://example.test')).toThrow(
      /http or https/i,
    );
  });
});

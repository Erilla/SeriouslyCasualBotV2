import { getDatabase } from '../../database/db.js';
import type { GuildInfoContentRow, GuildInfoLinkRow, ScheduleDayRow } from '../../types/index.js';

export type RecruitmentChoice = 'who' | 'want' | 'give' | 'contact';
export type ScheduleDayChoice = 'wednesday' | 'sunday';
export type LinkChoice = 'raiderio' | 'wowprogress' | 'warcraftlogs';

const RECRUITMENT_KEYS = {
  who: 'recruitment_who',
  want: 'recruitment_want',
  give: 'recruitment_give',
  contact: 'recruitment_contact',
} as const;

const SCHEDULE_SORT_ORDERS = { wednesday: 1, sunday: 2 } as const;
const LINK_OFFSETS = { raiderio: 0, wowprogress: 1, warcraftlogs: 2 } as const;

export interface EditableScheduleConfig {
  title: string;
  timezone: string;
}

function requireText(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label} is required.`);
  return value;
}

export function validateGuildInfoUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Link URL must use http or https.');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Link URL must use http or https.');
  }

  return value;
}

export function getAboutUs(): GuildInfoContentRow | null {
  return (
    (getDatabase()
      .prepare('SELECT key, title, content FROM guild_info_content WHERE key = ?')
      .get('aboutus') as GuildInfoContentRow | undefined) ?? null
  );
}

export function saveAboutUs(title: string, content: string): boolean {
  return (
    getDatabase()
      .prepare('UPDATE guild_info_content SET title = ?, content = ? WHERE key = ?')
      .run(requireText(title, 'About Us heading'), requireText(content, 'About Us body'), 'aboutus')
      .changes === 1
  );
}

export function getRecruitmentSection(choice: RecruitmentChoice): GuildInfoContentRow | null {
  return (
    (getDatabase()
      .prepare('SELECT key, title, content FROM guild_info_content WHERE key = ?')
      .get(RECRUITMENT_KEYS[choice]) as GuildInfoContentRow | undefined) ?? null
  );
}

export function saveRecruitmentSection(
  choice: RecruitmentChoice,
  title: string,
  content: string,
): boolean {
  return (
    getDatabase()
      .prepare('UPDATE guild_info_content SET title = ?, content = ? WHERE key = ?')
      .run(
        requireText(title, 'Section heading'),
        requireText(content, 'Section body'),
        RECRUITMENT_KEYS[choice],
      ).changes === 1
  );
}

export function getScheduleConfig(): EditableScheduleConfig | null {
  const rows = getDatabase()
    .prepare('SELECT key, value FROM schedule_config WHERE key IN (?, ?)')
    .all('title', 'timezone') as { key: string; value: string }[];
  const values = new Map(rows.map((row) => [row.key, row.value]));
  const title = values.get('title');
  const timezone = values.get('timezone');
  return title === undefined || timezone === undefined ? null : { title, timezone };
}

export function saveScheduleConfig(title: string, timezone: string): boolean {
  const requiredTitle = requireText(title, 'Schedule heading');
  const requiredTimezone = requireText(timezone, 'Schedule timezone');
  const db = getDatabase();

  return db.transaction(() => {
    const seededRows = db
      .prepare('SELECT COUNT(*) AS count FROM schedule_config WHERE key IN (?, ?)')
      .get('title', 'timezone') as { count: number };
    if (seededRows.count !== 2) return false;

    return (
      db.prepare('UPDATE schedule_config SET value = ? WHERE key = ?').run(requiredTitle, 'title')
        .changes === 1 &&
      db
        .prepare('UPDATE schedule_config SET value = ? WHERE key = ?')
        .run(requiredTimezone, 'timezone').changes === 1
    );
  })();
}

export function getScheduleDay(choice: ScheduleDayChoice): ScheduleDayRow | null {
  return (
    (getDatabase()
      .prepare('SELECT id, day, time, sort_order FROM schedule_days WHERE sort_order = ?')
      .get(SCHEDULE_SORT_ORDERS[choice]) as ScheduleDayRow | undefined) ?? null
  );
}

export function saveScheduleDay(choice: ScheduleDayChoice, day: string, time: string): boolean {
  return (
    getDatabase()
      .prepare('UPDATE schedule_days SET day = ?, time = ? WHERE sort_order = ?')
      .run(
        requireText(day, 'Schedule day'),
        requireText(time, 'Schedule time'),
        SCHEDULE_SORT_ORDERS[choice],
      ).changes === 1
  );
}

export function getGuildInfoLink(choice: LinkChoice): GuildInfoLinkRow | null {
  return (
    (getDatabase()
      .prepare('SELECT id, label, url, emoji_id FROM guild_info_links ORDER BY id LIMIT 1 OFFSET ?')
      .get(LINK_OFFSETS[choice]) as GuildInfoLinkRow | undefined) ?? null
  );
}

export function saveGuildInfoLink(choice: LinkChoice, label: string, url: string): boolean {
  const link = getGuildInfoLink(choice);
  if (!link) return false;

  return (
    getDatabase()
      .prepare('UPDATE guild_info_links SET label = ?, url = ? WHERE id = ?')
      .run(requireText(label, 'Link label'), validateGuildInfoUrl(url), link.id).changes === 1
  );
}

export function getAchievementsTitle(): GuildInfoContentRow | null {
  return (
    (getDatabase()
      .prepare('SELECT key, title, content FROM guild_info_content WHERE key = ?')
      .get('achievements_title') as GuildInfoContentRow | undefined) ?? null
  );
}

export function saveAchievementsTitle(title: string): boolean {
  return (
    getDatabase()
      .prepare('UPDATE guild_info_content SET title = ? WHERE key = ?')
      .run(requireText(title, 'Achievements heading'), 'achievements_title').changes === 1
  );
}

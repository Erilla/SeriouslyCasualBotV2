import type { TrialRow, ApplicationRow } from '../types/index.js';

/** `**Name** (#id)`, plus ` — <#thread_id>` when the review thread exists. */
export function trialRef(trial: Pick<TrialRow, 'character_name' | 'id' | 'thread_id'>): string {
  const base = `**${trial.character_name}** (#${trial.id})`;
  return trial.thread_id ? `${base} — <#${trial.thread_id}>` : base;
}

/**
 * `**Name** (<@applicant>)`, plus ` — <#post>` when a forum post/thread exists.
 * Prefers `forum_post_id`, falling back to `thread_id`.
 */
export function applicationRef(
  app: Pick<ApplicationRow, 'character_name' | 'applicant_user_id' | 'thread_id' | 'forum_post_id'>,
): string {
  const name = app.character_name ?? 'Unknown';
  const base = `**${name}** (<@${app.applicant_user_id}>)`;
  const postId = app.forum_post_id ?? app.thread_id;
  return postId ? `${base} — <#${postId}>` : base;
}

/**
 * Render a `YYYY-MM-DD` string as a Discord long-date timestamp (static full
 * date, localised to each viewer). Falls back to the raw string if unparseable.
 */
export function dateRef(date: string): string {
  const ms = Date.parse(date);
  if (Number.isNaN(ms)) return date;
  return `<t:${Math.floor(ms / 1000)}:D>`;
}

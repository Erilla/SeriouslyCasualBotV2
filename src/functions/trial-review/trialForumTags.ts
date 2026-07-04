import type { AnyThreadChannel, ForumChannel } from 'discord.js';
import { logger } from '../../services/logger.js';

export const TRIAL_TAG_NAMES = ['Active', 'To Be Promoted', 'Promoted', 'Failed'] as const;

/**
 * Ensure the trial-reviews forum has the four status tags. Additive and safe:
 * only creates tags that are missing, preserving any existing ones. Returns the
 * forum (refetched when tags were added, so availableTags carries their ids).
 */
export async function ensureTrialForumTags(forum: ForumChannel): Promise<ForumChannel> {
  const existing = forum.availableTags;
  const missing = TRIAL_TAG_NAMES.filter((name) => !existing.some((t) => t.name === name));
  if (missing.length === 0) return forum;

  try {
    await forum.setAvailableTags([...existing, ...missing.map((name) => ({ name }))]);
    return (await forum.fetch()) as ForumChannel;
  } catch (error) {
    logger.error('Trials', 'Failed to seed trial forum tags', error as Error);
    return forum;
  }
}

/**
 * Set a trial thread's status tag. A trial carries exactly one tag, so this
 * replaces any existing applied tags. No-ops (with a warning) if the tag or
 * the parent forum can't be resolved, so it never breaks the caller's flow.
 */
export async function applyTrialTag(
  thread: AnyThreadChannel,
  tagName: (typeof TRIAL_TAG_NAMES)[number],
): Promise<void> {
  const parent = thread.parent;
  if (!parent || !('availableTags' in parent)) return;

  const forum = parent as ForumChannel;
  const tag = forum.availableTags.find((t) => t.name === tagName);
  if (!tag) {
    logger.warn('Trials', `Trial forum tag "${tagName}" not found; skipping`);
    return;
  }

  try {
    await thread.setAppliedTags([tag.id]);
  } catch (error) {
    logger.warn('Trials', `Failed to apply tag "${tagName}" to thread ${thread.id}: ${error}`);
  }
}

import type { Message } from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';
import { applyLinkedCharacters } from './applyLinkedCharacters.js';
import { collectCharacterLinkCandidates } from './characterLinks.js';
import { resolveCharacterLinks } from './resolveCharacterLinks.js';
import { getJobByApplication } from './intel/jobStore.js';

/** The active application whose conversation this channel or thread is, if any. */
function findActiveApplication(
  channelId: string,
): { id: number; character_name: string | null } | undefined {
  return getDatabase()
    .prepare(
      `SELECT id, character_name FROM applications
        WHERE status = 'active' AND (channel_id = ? OR thread_id = ?)
        ORDER BY id DESC LIMIT 1`,
    )
    .get(channelId, channelId) as { id: number; character_name: string | null } | undefined;
}

/**
 * Pick up character links as they are pasted into an application conversation.
 *
 * Parsing comes before any database or network work on purpose. This runs on
 * every guild message the bot can see, and the overwhelming majority contain no
 * URL at all — so the cheap regex sweep is what keeps the common case free.
 *
 * Nothing here schedules a run of its own. `requestTopUp` marks the job, and the
 * existing 60-second resume tick coalesces however many links arrive in that
 * window into a single sweep.
 */
export async function harvestLinkedCharacters(message: Message): Promise<void> {
  const candidates = collectCharacterLinkCandidates(message.content);
  if (candidates.length === 0) return;

  const application = findActiveApplication(message.channelId);
  if (!application) return;

  const job = getJobByApplication(application.id);
  if (!job) return;

  try {
    const { identities } = await resolveCharacterLinks(candidates);
    const novel = applyLinkedCharacters(job, application.character_name, identities);
    if (novel.length === 0) return;

    logger.info(
      'Applications',
      `Application #${application.id}: harvested ${novel.length} linked character(s) into intel job #${job.id}`,
    );
  } catch (error) {
    // Automatic detection never retries: a failed lookup here is invisible to
    // everyone, and the officer Refresh control exists precisely so a missed
    // link can be recovered deliberately. Throwing would escape into the
    // messageCreate handler and take the DM questionnaire down with it.
    logger.warn(
      'Applications',
      `Application #${application.id}: could not resolve linked characters: ${error}`,
    );
  }
}

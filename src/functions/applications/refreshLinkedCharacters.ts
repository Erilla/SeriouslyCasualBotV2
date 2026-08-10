import type { Guild, TextBasedChannel } from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';
import { collectCharacterLinkCandidates, type RaiderIoCharacter } from './characterLinks.js';
import { resolveCharacterLinks } from './resolveCharacterLinks.js';
import {
  getApplicantCharacters,
  getJobByApplication,
  getLinkedCharacters,
  requestTopUp,
  setJobPrimary,
  setLinkedCharacters,
} from './intel/jobStore.js';

/** Discord's per-request maximum, and how many requests we are willing to make. */
const MESSAGES_PER_PAGE = 100;
const MAX_PAGES = 10;

export type RefreshOutcome = 'ok' | 'inactive' | 'no_job' | 'no_surfaces';

export interface RefreshResult {
  outcome: RefreshOutcome;
  /** Names newly persisted as linked characters, in resolution order. */
  queued: string[];
  /** Human-readable names of the surfaces that could not be read. */
  unavailableSurfaces: string[];
  /** True when a page cap was hit, so older messages went unread. */
  truncated: boolean;
}

interface Surface {
  label: string;
  channelId: string | null;
}

function identityKey(character: RaiderIoCharacter): string {
  return [character.region, character.realm, character.name]
    .map((part) => part.trim().normalize('NFC').toLowerCase())
    .join('/');
}

/**
 * Read back through a channel's history, newest first.
 *
 * Capped rather than exhaustive: an application channel is short-lived, but
 * nothing stops a chatty one, and an officer pressing a button must not be able
 * to start an unbounded walk of Discord's API. Hitting the cap is reported so the
 * reply can say the scan was partial instead of implying it found everything.
 */
async function readSurface(
  guild: Guild,
  channelId: string,
): Promise<{ contents: string[]; truncated: boolean }> {
  const channel = await guild.channels.fetch(channelId);
  if (!channel || !channel.isTextBased()) return { contents: [], truncated: false };

  const contents: string[] = [];
  let before: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await (channel as TextBasedChannel).messages.fetch({
      limit: MESSAGES_PER_PAGE,
      before,
    });
    if (batch.size === 0) return { contents, truncated: false };

    for (const message of batch.values()) contents.push(message.content);
    if (batch.size < MESSAGES_PER_PAGE) return { contents, truncated: false };
    before = batch.last()?.id;
    if (!before) return { contents, truncated: false };
  }
  return { contents, truncated: true };
}

/**
 * Rescan both application surfaces for character links and top the sweep up.
 *
 * A partial read still counts: a character found in the thread is worth queueing
 * even if the channel denied access, because the alternative is discarding real
 * evidence over an unrelated permission problem. The caller reports which
 * surfaces were missed so the officer knows to look again.
 */
export async function refreshLinkedCharacters(
  applicationId: number,
  guild: Guild,
): Promise<RefreshResult> {
  const empty = { queued: [], unavailableSurfaces: [], truncated: false };

  // Re-read rather than trusting the button: its message is never deleted, so a
  // click can arrive long after the application was decided.
  const application = getDatabase()
    .prepare('SELECT status, character_name, channel_id, thread_id FROM applications WHERE id = ?')
    .get(applicationId) as
    | {
        status: string;
        character_name: string | null;
        channel_id: string | null;
        thread_id: string | null;
      }
    | undefined;
  if (!application || application.status !== 'active') {
    return { ...empty, outcome: 'inactive' };
  }

  const job = getJobByApplication(applicationId);
  if (!job) return { ...empty, outcome: 'no_job' };

  const surfaces: Surface[] = [
    { label: 'application channel', channelId: application.channel_id },
    { label: 'application thread', channelId: application.thread_id },
  ];

  const contents: string[] = [];
  const unavailableSurfaces: string[] = [];
  let truncated = false;
  let readAny = false;
  for (const surface of surfaces) {
    if (!surface.channelId) continue;
    try {
      const read = await readSurface(guild, surface.channelId);
      contents.push(...read.contents);
      truncated = truncated || read.truncated;
      readAny = true;
      if (read.truncated) {
        logger.warn(
          'Applications',
          `Application #${applicationId}: stopped scanning the ${surface.label} at ${MAX_PAGES * MESSAGES_PER_PAGE} messages`,
        );
      }
    } catch (error) {
      unavailableSurfaces.push(surface.label);
      logger.warn(
        'Applications',
        `Application #${applicationId}: could not scan the ${surface.label}: ${error}`,
      );
    }
  }
  if (!readAny) return { ...empty, outcome: 'no_surfaces', unavailableSurfaces };

  // Parse before any network call, exactly as the message-create path does: most
  // refreshes of a link-free conversation should cost nothing beyond the reads.
  const candidates = contents.flatMap((content) => collectCharacterLinkCandidates(content));
  if (candidates.length === 0) {
    return { outcome: 'ok', queued: [], unavailableSurfaces, truncated };
  }

  const { identities } = await resolveCharacterLinks(candidates);

  const seen = new Set(
    [...getApplicantCharacters(job.id), ...getLinkedCharacters(job.id)].map(identityKey),
  );
  const novel = identities.filter((identity) => {
    const key = identityKey(identity);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (novel.length === 0) {
    return { outcome: 'ok', queued: [], unavailableSurfaces, truncated };
  }

  setLinkedCharacters(job.id, novel);

  // An idle job has no primary yet. Prefer the character the application itself
  // named — the applicant's own answer is better evidence of who they are than
  // whichever URL happened to appear first — and fall back to link order.
  if (job.character_name === '') {
    const declared = application.character_name?.trim().toLocaleLowerCase();
    const byName = declared
      ? novel.find((identity) => identity.name.trim().toLocaleLowerCase() === declared)
      : undefined;
    setJobPrimary(job.id, byName ?? novel[0]);
  }

  requestTopUp(job.id);
  logger.info(
    'Applications',
    `Application #${applicationId}: queued ${novel.length} linked character(s) for intel job #${job.id}`,
  );

  return {
    outcome: 'ok',
    queued: novel.map((identity) => identity.name),
    unavailableSurfaces,
    truncated,
  };
}

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, Colors } from 'discord.js';
import {
  createJob,
  setApplicantCharacters,
  setControlMessageId,
  setMessageIds,
  type JobStatus,
} from './jobStore.js';
import type { RaiderIoCharacter } from '../characterLinks.js';

/**
 * Discord cannot insert a message between existing ones, and the sweep takes
 * seconds to minutes, so the reading order (Q&A -> characters -> guild
 * history -> logs -> voting) is only achievable by reserving these three
 * positions up front and editing them in place.
 */
const PLACEHOLDER_TEXT = {
  alts: '**Found characters** — searching…',
  guilds: '**Guild history** — searching…',
  logs: '**Mythic raid logs** — fetching…',
} as const;

/**
 * Copy for the same three positions when nothing is queued to fill them.
 *
 * The positions are now reserved unconditionally, because an applicant who named
 * no character can still paste one into the channel later and Discord cannot
 * insert a message above the voting controls after the fact. "Searching…" would
 * be a lie in that state — it says the bot is working when no job exists — so the
 * idle copy tells the reviewer what would make it start.
 */
const IDLE_TEXT = {
  alts: '**Found characters** — no character to search yet. Link one in this thread or the application channel, then press Refresh.',
  guilds: '**Guild history** — waiting for a character to search.',
  logs: '**Mythic raid logs** — waiting for a character to search.',
} as const;

export function placeholderEmbed(kind: 'alts' | 'guilds' | 'logs'): EmbedBuilder {
  return new EmbedBuilder().setColor(Colors.Grey).setDescription(PLACEHOLDER_TEXT[kind]);
}

export function idlePlaceholderEmbed(kind: 'alts' | 'guilds' | 'logs'): EmbedBuilder {
  return new EmbedBuilder().setColor(Colors.Grey).setDescription(IDLE_TEXT[kind]);
}

/**
 * The officer control that rescans both application surfaces for character links.
 *
 * Disabled while a sweep is in flight, purely as a hint: a stale click on a
 * message Discord never deletes still routes, and the handler treats it as an
 * ordinary top-up request rather than an error.
 */
export function intelRefreshRow(
  applicationId: number,
  jobStatus: JobStatus | null,
): ActionRowBuilder<ButtonBuilder> {
  const inFlight = jobStatus === 'pending' || jobStatus === 'running';
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`application:intel_refresh:${applicationId}`)
      .setLabel(inFlight ? 'Refreshing…' : 'Refresh characters')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(inFlight),
  );
}

/** Stands in for the primary until a refresh resolves one; see setJobPrimary. */
const UNNAMED_PRIMARY: RaiderIoCharacter = { region: '', realm: '', name: '' };

export function startIntelJob(input: {
  applicationId: number | null;
  targetChannelId: string;
  /**
   * Every character the applicant named; the first is the primary for identity.
   * Empty reserves an 'idle' job that the scheduler ignores until a linked
   * character reopens it, so the three message ids have an owner from the start.
   */
  characters: RaiderIoCharacter[];
  /** Discord username, for the confirmation pass. Null disables it. */
  applicantDiscord?: string | null;
  altsMessageId?: string;
  guildsMessageId?: string;
  logsMessageId?: string;
  /** The officer Refresh control, so its enabled state can track job status. */
  refreshMessageId?: string;
}): number {
  // createJob writes the row with status 'pending', which makes it immediately
  // visible to the scheduler's dueJobs query. setApplicantCharacters and
  // setMessageIds run right after, still synchronously — createJob,
  // setApplicantCharacters, setMessageIds and enqueue are all synchronous
  // better-sqlite3 calls, and JS is single-threaded, so a scheduler tick can
  // never interleave between them. Do NOT introduce an `await` anywhere in
  // this sequence: if a scheduler tick ran the job while its message ids were
  // still null, `publish` would edit nothing and the job would finish 'done'
  // leaving three permanent "searching…" placeholders — unrecoverable.
  const jobId = createJob({
    applicationId: input.applicationId,
    targetChannelId: input.targetChannelId,
    character: input.characters[0] ?? UNNAMED_PRIMARY,
    applicantDiscord: input.applicantDiscord ?? null,
    status: input.characters.length > 0 ? 'pending' : 'idle',
  });
  setApplicantCharacters(jobId, input.characters);
  setMessageIds(jobId, {
    alts: input.altsMessageId,
    guilds: input.guildsMessageId,
    logs: input.logsMessageId,
  });
  if (input.refreshMessageId) setControlMessageId(jobId, input.refreshMessageId);
  return jobId;
}

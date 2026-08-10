import { EmbedBuilder, Colors } from 'discord.js';
import { createJob, setApplicantCharacters, setMessageIds } from './jobStore.js';
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

export function placeholderEmbed(kind: 'alts' | 'guilds' | 'logs'): EmbedBuilder {
  return new EmbedBuilder().setColor(Colors.Grey).setDescription(PLACEHOLDER_TEXT[kind]);
}

export function startIntelJob(input: {
  applicationId: number | null;
  targetChannelId: string;
  /** Every character the applicant named; the first is the primary for identity. */
  characters: RaiderIoCharacter[];
  /** Discord username, for the confirmation pass. Null disables it. */
  applicantDiscord?: string | null;
  altsMessageId?: string;
  guildsMessageId?: string;
  logsMessageId?: string;
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
    character: input.characters[0],
    applicantDiscord: input.applicantDiscord ?? null,
  });
  setApplicantCharacters(jobId, input.characters);
  setMessageIds(jobId, {
    alts: input.altsMessageId,
    guilds: input.guildsMessageId,
    logs: input.logsMessageId,
  });
  return jobId;
}

import { MessageFlags } from 'discord.js';
import type { ButtonInteraction, ModalSubmitInteraction } from 'discord.js';
import type { ButtonHandler, ModalHandler } from './registry.js';
import { config } from '../config.js';
import { getDatabase } from '../database/db.js';
import { refreshLinkedCharacters } from '../functions/applications/refreshLinkedCharacters.js';
import { audit, alertOfficers } from '../services/auditLog.js';
import { logger } from '../services/logger.js';
import { startApplication } from '../functions/applications/startApplication.js';
import { resolveMember } from '../functions/applications/resolveMember.js';
import { submitApplication } from '../functions/applications/submitApplication.js';
import { buildSummaryRow } from '../functions/applications/summaryButtons.js';
import {
  clearSession,
  enterEditMode,
  startSessionTimeout,
} from '../functions/applications/dmQuestionnaire.js';
import { voteOnApplication } from '../functions/applications/voteOnApplication.js';
import {
  acceptApplication,
  processAcceptModal,
} from '../functions/applications/acceptApplication.js';
import {
  rejectApplication,
  processRejectModal,
} from '../functions/applications/rejectApplication.js';

async function apply(interaction: ButtonInteraction, _params: string[]): Promise<void> {
  // Deferred before any of the work below. Discord invalidates the interaction
  // token 3 seconds after delivery, and this path fetches the guild member and
  // sends a DM before it knows what to say — on a cold member cache or a
  // rate-limited DM that is enough to blow the window, leaving the applicant
  // looking at "This interaction failed" even though their application was
  // created. Deferring buys 15 minutes for the editReply below.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const result = await startApplication(interaction.user, await resolveMember(interaction));

  const content =
    result.outcome === 'started'
      ? "Check your DMs! I've sent you the application questions."
      : result.outcome === 'dm_failed'
        ? 'I was unable to send you a DM. Please make sure your DMs are open and try again.'
        : result.message;

  await interaction.editReply({ content });
}

const ALREADY_SUBMITTED = 'Application already submitted.';
const SUBMISSION_IN_FLIGHT = 'Your application is being submitted — give it a moment.';
const NO_LONGER_OPEN = 'This application is no longer open. Start a new one any time with /apply.';
const NO_LONGER_ACTIVE = 'This application is no longer active, so its intel cannot be topped up.';

/**
 * Why the summary buttons can no longer act on an application, or null when they
 * still can.
 *
 * The summary DM's buttons use static custom IDs on a message that is never
 * deleted, so Discord will happily route a click that arrives days later. Every
 * handler therefore re-checks state rather than trusting the button was
 * clickable — and the reason matters, because "already submitted" told an
 * applicant whose application had merely lapsed that officers had it.
 *
 * `submitted_at` is part of the test, not just status: the submission claim
 * holds status at 'in_progress' for the several seconds the Discord work takes,
 * so a status-only check let Cancel and Edit act on an in-flight submission.
 */
function closedReason(applicationId: number): string | null {
  const row = getDatabase()
    .prepare('SELECT status, submitted_at FROM applications WHERE id = ?')
    .get(applicationId) as { status: string; submitted_at: string | null } | undefined;

  if (!row) return NO_LONGER_OPEN;
  if (row.status !== 'in_progress') {
    return row.status === 'abandoned' ? NO_LONGER_OPEN : ALREADY_SUBMITTED;
  }
  return row.submitted_at ? SUBMISSION_IN_FLIGHT : null;
}

/**
 * Grey out the summary buttons once they can no longer do anything. Best-effort:
 * the DM may be too old to edit, and this is cosmetic — the state checks above
 * are what actually prevent duplicate work.
 */
async function spendSummaryButtons(
  interaction: ButtonInteraction,
  applicationId: number,
): Promise<void> {
  try {
    await interaction.message.edit({
      components: [buildSummaryRow(applicationId, { disabled: true })],
    });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.debug(
      'Applications',
      `Could not disable summary buttons for application #${applicationId}: ${error.message}`,
    );
  }
}

async function edit(interaction: ButtonInteraction, params: string[]): Promise<void> {
  const applicationId = parseInt(params[0], 10);

  // Editing after submission rewrote the stored answers while the Q&A already
  // posted to the channel and forum thread stayed a stale snapshot, then handed
  // back a fresh Confirm & Submit — the loop that produced a duplicate.
  const editClosed = closedReason(applicationId);
  if (editClosed) {
    await interaction.reply({ content: editClosed, flags: MessageFlags.Ephemeral });
    await spendSummaryButtons(interaction, applicationId);
    return;
  }

  enterEditMode(interaction.user.id, applicationId);
  startSessionTimeout(interaction.user);

  try {
    await interaction.user.send('Which answer would you like to change? (enter the number)');
    // The Edit Answer button only ever appears inside the applicant's DMs
    // (showSummary always sends via user.send), so a "check your DMs" reply
    // would be redundant. Just acknowledge the click silently.
    await interaction.deferUpdate();
  } catch {
    clearSession(interaction.user.id);
    await interaction.reply({
      content: 'I was unable to send you a DM. Please make sure your DMs are open.',
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function confirm(interaction: ButtonInteraction, params: string[]): Promise<void> {
  const applicationId = parseInt(params[0], 10);

  await interaction.reply({
    content: 'Submitting your application...',
    flags: MessageFlags.Ephemeral,
  });

  try {
    const result = await submitApplication(interaction.client, applicationId, interaction.user);
    await interaction.editReply({
      content:
        result === 'already_submitted'
          ? ALREADY_SUBMITTED
          : 'Your application has been submitted! Officers will review it shortly.',
    });
    // The Edit flow arms a 30-minute inactivity timeout that marks the
    // application 'abandoned'. Clicking Confirm instead of answering left it
    // running, so a submitted application quietly went 'abandoned' half an hour
    // later while its channel and forum thread stayed up.
    clearSession(interaction.user.id);

    // Only on a settled outcome. A failed submission leaves the buttons live so
    // the applicant can retry from the same message.
    await spendSummaryButtons(interaction, applicationId);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error(
      'Applications',
      `Failed to submit application #${applicationId}: ${error.message}`,
      error,
    );

    // Officers would otherwise only see this in stdout. Ping the audit
    // channel so they have an action item. Don't await-block the user
    // reply on the alert path — applicant feedback comes first, and
    // alertOfficers catches its own failures. (#42)
    void alertOfficers(
      `Application #${applicationId} submission failed`,
      `Applicant: ${interaction.user.tag} (${interaction.user.id})\nError: ${error.message}`,
    );

    await interaction.editReply({
      content:
        `There was an error submitting your application (saved as #${applicationId}). ` +
        `An officer has been notified — please include application #${applicationId} ` +
        `when following up.`,
    });
  }
}

async function cancel(interaction: ButtonInteraction, params: string[]): Promise<void> {
  const applicationId = parseInt(params[0], 10);
  const db = getDatabase();

  // Cancelling used to be unconditional, so a late click would retire a live
  // application officers were already voting on while leaving its channel and
  // forum thread standing.
  const cancelClosed = closedReason(applicationId);
  if (cancelClosed) {
    await interaction.reply({ content: cancelClosed, flags: MessageFlags.Ephemeral });
    await spendSummaryButtons(interaction, applicationId);
    return;
  }

  db.prepare('UPDATE applications SET status = ? WHERE id = ?').run('abandoned', applicationId);

  clearSession(interaction.user.id);

  try {
    await interaction.user.send(
      'Your application has been cancelled. You can apply again anytime with /apply.',
    );
  } catch {
    // DMs may be disabled
  }

  await interaction.reply({
    content: 'Application cancelled.',
    flags: MessageFlags.Ephemeral,
  });
}

async function vote(interaction: ButtonInteraction, params: string[]): Promise<void> {
  // customId: application_vote:{type}:{applicationId}
  // params = [voteType, applicationIdStr]
  const voteType = params[0];
  const applicationId = parseInt(params[1], 10);
  await voteOnApplication(interaction, applicationId, voteType);
}

async function accept(interaction: ButtonInteraction, _params: string[]): Promise<void> {
  await acceptApplication(interaction);
}

/**
 * Rescan the application's channel and thread for character links.
 *
 * Officer-only and ephemeral: it reports which surfaces were readable, which is
 * reviewer diagnostics rather than anything the applicant should see in the
 * thread. There is deliberately no cooldown — a redundant scan finds nothing new
 * and requests no top-up, so the worst a double-click costs is two reads.
 */
async function intelRefresh(interaction: ButtonInteraction, params: string[]): Promise<void> {
  const applicationId = parseInt(params[0], 10);
  const member = await resolveMember(interaction);
  if (!member?.roles.cache.has(config.officerRoleId)) {
    await interaction.reply({
      content: 'Only officers can refresh linked characters.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!interaction.guild) {
    await interaction.editReply({ content: 'This control only works inside the guild.' });
    return;
  }

  const result = await refreshLinkedCharacters(applicationId, interaction.guild);

  if (result.outcome === 'inactive') {
    await interaction.editReply({ content: NO_LONGER_ACTIVE });
    return;
  }
  if (result.outcome === 'no_job') {
    await interaction.editReply({
      content: `Application #${applicationId} has no intel job to top up.`,
    });
    return;
  }
  if (result.outcome === 'no_surfaces') {
    // An application with both channel_id and thread_id NULL reaches here with
    // nothing to name, so the permissions advice would read "I could not read
    // the ." — wrong problem and wrong fix.
    await interaction.editReply({
      content:
        result.unavailableSurfaces.length > 0
          ? `I could not read the ${result.unavailableSurfaces.join(' or ')}. Check my permissions and try again.`
          : `Application #${applicationId} has no channel or thread left to scan.`,
    });
    return;
  }

  const notes = [
    result.unavailableSurfaces.length > 0
      ? `Could not read the ${result.unavailableSurfaces.join(' or ')}.`
      : null,
    result.truncated ? 'The conversation was long, so only recent messages were scanned.' : null,
  ].filter((note): note is string => note !== null);

  const summary =
    result.queued.length > 0
      ? `Queued ${result.queued.length} new character(s): ${result.queued.join(', ')}. The sweep will update this thread shortly.`
      : 'No new linked characters found.';

  await interaction.editReply({ content: [summary, ...notes].join(' ') });
}

async function reject(interaction: ButtonInteraction, _params: string[]): Promise<void> {
  await rejectApplication(interaction);
}

async function modalAcceptMessage(
  interaction: ModalSubmitInteraction,
  _params: string[],
): Promise<void> {
  const message = interaction.fields.getTextInputValue('message');
  const db = getDatabase();
  db.prepare('INSERT OR REPLACE INTO default_messages (key, message) VALUES (?, ?)').run(
    'application_accept',
    message,
  );

  await audit(interaction.user, 'updated accept message', message.substring(0, 100));
  await interaction.reply({ content: 'Accept message updated.', flags: MessageFlags.Ephemeral });
}

async function modalRejectMessage(
  interaction: ModalSubmitInteraction,
  _params: string[],
): Promise<void> {
  const message = interaction.fields.getTextInputValue('message');
  const db = getDatabase();
  db.prepare('INSERT OR REPLACE INTO default_messages (key, message) VALUES (?, ?)').run(
    'application_reject',
    message,
  );

  await audit(interaction.user, 'updated reject message', message.substring(0, 100));
  await interaction.reply({ content: 'Reject message updated.', flags: MessageFlags.Ephemeral });
}

async function modalAccept(interaction: ModalSubmitInteraction, _params: string[]): Promise<void> {
  await processAcceptModal(interaction);
}

async function modalReject(interaction: ModalSubmitInteraction, _params: string[]): Promise<void> {
  await processRejectModal(interaction);
}

export const buttons: ButtonHandler[] = [
  { prefix: 'application:apply', handle: apply },
  { prefix: 'application:edit', handle: edit },
  { prefix: 'application:confirm', handle: confirm },
  { prefix: 'application:cancel', handle: cancel },
  { prefix: 'application:accept', handle: accept },
  { prefix: 'application:reject', handle: reject },
  { prefix: 'application:intel_refresh', handle: intelRefresh },
  { prefix: 'application_vote', handle: vote },
];

export const modals: ModalHandler[] = [
  { prefix: 'application:modal:accept_message', handle: modalAcceptMessage },
  { prefix: 'application:modal:reject_message', handle: modalRejectMessage },
  { prefix: 'application:modal:accept', handle: modalAccept },
  { prefix: 'application:modal:reject', handle: modalReject },
];

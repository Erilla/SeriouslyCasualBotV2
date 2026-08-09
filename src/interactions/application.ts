import { MessageFlags } from 'discord.js';
import type { ButtonInteraction, ModalSubmitInteraction } from 'discord.js';
import type { ButtonHandler, ModalHandler } from './registry.js';
import { getDatabase } from '../database/db.js';
import { audit, alertOfficers } from '../services/auditLog.js';
import { logger } from '../services/logger.js';
import { startApplication } from '../functions/applications/startApplication.js';
import { submitApplication } from '../functions/applications/submitApplication.js';
import { buildSummaryRow } from '../functions/applications/summaryButtons.js';
import {
  activeSessions,
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
  const success = await startApplication(interaction.user);

  if (success) {
    await interaction.reply({
      content: "Check your DMs! I've sent you the application questions.",
      flags: MessageFlags.Ephemeral,
    });
  } else {
    await interaction.reply({
      content: 'I was unable to send you a DM. Please make sure your DMs are open and try again.',
      flags: MessageFlags.Ephemeral,
    });
  }
}

const ALREADY_SUBMITTED = 'Application already submitted.';

/**
 * Whether the application is still open to Edit/Confirm/Cancel.
 *
 * The summary DM's buttons use static custom IDs on a message that is never
 * deleted, so Discord will happily route a click that arrives days after the
 * application was submitted. Every handler therefore re-checks state rather
 * than trusting that the button was clickable.
 */
function isOpenForEditing(applicationId: number): boolean {
  const row = getDatabase()
    .prepare('SELECT status FROM applications WHERE id = ?')
    .get(applicationId) as { status: string } | undefined;
  return row?.status === 'in_progress';
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
  if (!isOpenForEditing(applicationId)) {
    await interaction.reply({ content: ALREADY_SUBMITTED, flags: MessageFlags.Ephemeral });
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
    activeSessions.delete(interaction.user.id);
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
  if (!isOpenForEditing(applicationId)) {
    await interaction.reply({ content: ALREADY_SUBMITTED, flags: MessageFlags.Ephemeral });
    await spendSummaryButtons(interaction, applicationId);
    return;
  }

  db.prepare('UPDATE applications SET status = ? WHERE id = ?').run('abandoned', applicationId);

  activeSessions.delete(interaction.user.id);

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
  { prefix: 'application_vote', handle: vote },
];

export const modals: ModalHandler[] = [
  { prefix: 'application:modal:accept_message', handle: modalAcceptMessage },
  { prefix: 'application:modal:reject_message', handle: modalRejectMessage },
  { prefix: 'application:modal:accept', handle: modalAccept },
  { prefix: 'application:modal:reject', handle: modalReject },
];

import {
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} from 'discord.js';
import type { ButtonInteraction, ModalSubmitInteraction } from 'discord.js';
import type { ButtonHandler, ModalHandler } from './registry.js';
import { getDatabase } from '../database/db.js';
import { audit } from '../services/auditLog.js';
import { dateRef, trialRef } from '../services/auditRefs.js';
import { logger } from '../services/logger.js';
import { extendTrial } from '../functions/trial-review/extendTrial.js';
import { markForPromotion } from '../functions/trial-review/markForPromotion.js';
import { closeTrial } from '../functions/trial-review/closeTrial.js';
import { changeTrialInfo } from '../functions/trial-review/changeTrialInfo.js';
import { createTrialReviewThread } from '../functions/trial-review/createTrialReviewThread.js';
import type { TrialAlertRow, TrialRow } from '../types/index.js';

async function updateInfo(interaction: ButtonInteraction, params: string[]): Promise<void> {
  const trialId = parseInt(params[0], 10);
  const db = getDatabase();
  const trial = db.prepare('SELECT * FROM trials WHERE id = ?').get(trialId) as
    | TrialRow
    | undefined;

  if (!trial) {
    await interaction.reply({ content: 'Trial not found.', flags: MessageFlags.Ephemeral });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`trial:modal:update:${trialId}`)
    .setTitle('Update Trial Info');

  const charNameInput = new TextInputBuilder()
    .setCustomId('character_name')
    .setLabel('Character Name')
    .setStyle(TextInputStyle.Short)
    .setValue(trial.character_name)
    .setRequired(true);

  const roleInput = new TextInputBuilder()
    .setCustomId('role')
    .setLabel('Role')
    .setStyle(TextInputStyle.Short)
    .setValue(trial.role)
    .setRequired(true);

  const startDateInput = new TextInputBuilder()
    .setCustomId('start_date')
    .setLabel('Start Date (YYYY-MM-DD)')
    .setStyle(TextInputStyle.Short)
    .setValue(trial.start_date)
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(charNameInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(roleInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(startDateInput),
  );

  await interaction.showModal(modal);
}

async function extend(interaction: ButtonInteraction, params: string[]): Promise<void> {
  const trialId = parseInt(params[0], 10);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const trial = getDatabase().prepare('SELECT * FROM trials WHERE id = ?').get(trialId) as
    | TrialRow
    | undefined;

  try {
    await extendTrial(interaction.client, trialId);
    const endAlert = getDatabase()
      .prepare("SELECT alert_date FROM trial_alerts WHERE trial_id = ? AND alert_name = '6_week'")
      .get(trialId) as Pick<TrialAlertRow, 'alert_date'> | undefined;
    const detail = trial
      ? `${trialRef(trial)}${endAlert ? `; ends ${dateRef(endAlert.alert_date)}` : ''}`
      : `#${trialId}`;
    await audit(interaction.user, 'extended trial', detail);
    await interaction.editReply({ content: 'Trial extended by 1 week.' });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    await interaction.editReply({ content: `Failed to extend trial: ${error.message}` });
  }
}

async function markPromote(interaction: ButtonInteraction, params: string[]): Promise<void> {
  const trialId = parseInt(params[0], 10);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const trial = getDatabase().prepare('SELECT * FROM trials WHERE id = ?').get(trialId) as
    | TrialRow
    | undefined;

  try {
    await markForPromotion(interaction.client, trialId);
    await audit(
      interaction.user,
      'marked trial for promotion',
      trial ? trialRef(trial) : `#${trialId}`,
    );
    await interaction.editReply({ content: 'Trial marked for promotion.' });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    await interaction.editReply({ content: `Failed: ${error.message}` });
  }
}

async function close(interaction: ButtonInteraction, params: string[]): Promise<void> {
  const trialId = parseInt(params[0], 10);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const trial = getDatabase().prepare('SELECT * FROM trials WHERE id = ?').get(trialId) as
    | TrialRow
    | undefined;

  try {
    await closeTrial(interaction.client, trialId);
    await audit(interaction.user, 'closed trial', trial ? trialRef(trial) : `#${trialId}`);
    await interaction.editReply({ content: 'Trial closed.' });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    await interaction.editReply({ content: `Failed to close trial: ${error.message}` });
  }
}

async function modalCreate(interaction: ModalSubmitInteraction, _params: string[]): Promise<void> {
  const characterName = interaction.fields.getTextInputValue('character_name');
  const role = interaction.fields.getTextInputValue('role');
  const startDate = interaction.fields.getTextInputValue('start_date');

  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    await interaction.reply({
      content: 'Invalid date format. Please use YYYY-MM-DD.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const trial = await createTrialReviewThread(interaction.client, {
      characterName,
      role,
      startDate,
    });
    const createdDetail = `**${characterName}** (#${trial.id}) as \`${role}\`${
      trial.thread_id ? ` — <#${trial.thread_id}>` : ''
    }`;
    await audit(interaction.user, 'created trial', createdDetail);
    await interaction.editReply({
      content: `Trial created for **${characterName}**. Thread: <#${trial.thread_id}>`,
    });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error('Trials', `Failed to create trial: ${error.message}`, error);
    await interaction.editReply({ content: `Failed to create trial: ${error.message}` });
  }
}

async function modalUpdate(interaction: ModalSubmitInteraction, params: string[]): Promise<void> {
  const trialId = parseInt(params[0], 10);
  const characterName = interaction.fields.getTextInputValue('character_name');
  const role = interaction.fields.getTextInputValue('role');
  const startDate = interaction.fields.getTextInputValue('start_date');

  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    await interaction.reply({
      content: 'Invalid date format. Please use YYYY-MM-DD.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const db = getDatabase();
    const trial = db.prepare('SELECT * FROM trials WHERE id = ?').get(trialId) as
      | TrialRow
      | undefined;

    if (!trial) {
      await interaction.editReply({ content: 'Trial not found.' });
      return;
    }

    const updates: Record<string, string | undefined> = {};
    if (characterName !== trial.character_name) updates.characterName = characterName;
    if (role !== trial.role) updates.role = role;
    if (startDate !== trial.start_date) updates.startDate = startDate;

    if (Object.keys(updates).length === 0) {
      await interaction.editReply({ content: 'No changes detected.' });
      return;
    }

    await changeTrialInfo(interaction.client, trialId, updates);
    await audit(interaction.user, 'updated trial info via modal', trialRef(trial));
    await interaction.editReply({ content: 'Trial info updated.' });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    await interaction.editReply({ content: `Failed to update trial: ${error.message}` });
  }
}

export const buttons: ButtonHandler[] = [
  { prefix: 'trial:update_info', officerOnly: true, handle: updateInfo },
  { prefix: 'trial:extend', officerOnly: true, handle: extend },
  { prefix: 'trial:mark_promote', officerOnly: true, handle: markPromote },
  { prefix: 'trial:close', officerOnly: true, handle: close },
];

export const modals: ModalHandler[] = [
  { prefix: 'trial:modal:create', handle: modalCreate },
  { prefix: 'trial:modal:update', handle: modalUpdate },
];

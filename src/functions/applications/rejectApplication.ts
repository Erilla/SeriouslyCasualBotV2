import {
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type GuildMember,
  type ForumChannel,
  type TextChannel,
  type AnyThreadChannel,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  AttachmentBuilder,
  MessageFlags,
} from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { config } from '../../config.js';
import { logger } from '../../services/logger.js';
import { audit } from '../../services/auditLog.js';
import { generateTranscript } from './generateTranscript.js';
import type { ApplicationRow, DefaultMessageRow } from '../../types/index.js';

/**
 * Show the Reject modal when an officer clicks the Reject button.
 */
export async function rejectApplication(interaction: ButtonInteraction): Promise<void> {
  // Officer permission check
  const member = interaction.member as GuildMember;
  if (!member.roles.cache.has(config.officerRoleId)) {
    await interaction.reply({
      content: 'You do not have permission to reject applications.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const applicationId = parseInt(interaction.customId.split(':')[2], 10);
  const db = getDatabase();

  const application = db
    .prepare('SELECT * FROM applications WHERE id = ?')
    .get(applicationId) as ApplicationRow | undefined;

  if (!application) {
    await interaction.reply({
      content: 'Application not found.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Get default reject message
  const defaultMsg = db
    .prepare('SELECT * FROM default_messages WHERE key = ?')
    .get('application_reject') as DefaultMessageRow | undefined;

  const defaultMessage =
    defaultMsg?.message ?? 'Thank you for your interest. Unfortunately, your application has been declined.';

  // Build and show modal
  const modal = new ModalBuilder()
    .setCustomId(`application:modal:reject:${applicationId}`)
    .setTitle('Reject Application');

  const messageInput = new TextInputBuilder()
    .setCustomId('message_to_applicant')
    .setLabel('Message to Applicant')
    .setStyle(TextInputStyle.Paragraph)
    .setValue(defaultMessage)
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(messageInput),
  );

  await interaction.showModal(modal);
}

/**
 * Process the Reject modal submission.
 */
export async function processRejectModal(interaction: ModalSubmitInteraction): Promise<void> {
  const applicationId = parseInt(interaction.customId.split(':')[3], 10);
  const db = getDatabase();

  const application = db
    .prepare('SELECT * FROM applications WHERE id = ?')
    .get(applicationId) as ApplicationRow | undefined;

  if (!application) {
    await interaction.reply({
      content: 'Application not found.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const messageToApplicant = interaction.fields.getTextInputValue('message_to_applicant');
  const characterName = application.character_name ?? 'Unknown';

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply({ content: 'This must be used in a server.' });
    return;
  }

  // Generate transcript from the app text channel
  let transcriptBuffer: Buffer | null = null;
  if (application.channel_id) {
    try {
      const appChannel = guild.channels.cache.get(application.channel_id) as TextChannel | undefined;
      if (appChannel) {
        const transcript = await generateTranscript(appChannel);
        transcriptBuffer = transcript.buffer;
      }
    } catch (error) {
      logger.warn('Applications', `Failed to generate transcript for application #${applicationId}: ${error}`);
    }
  }

  // Post transcript to the forum thread
  if (application.thread_id) {
    try {
      const thread = (await guild.channels.fetch(application.thread_id)) as AnyThreadChannel | null;
      if (thread?.isThread()) {
        const content = `Application **rejected** by ${interaction.user} for **${characterName}**.`;

        if (transcriptBuffer) {
          const attachment = new AttachmentBuilder(transcriptBuffer, {
            name: `transcript-${characterName.toLowerCase()}.txt`,
          });
          await thread.send({ content, files: [attachment] });
        } else {
          await thread.send(content);
        }

        // Update forum tags: remove Active, add Rejected
        await swapForumTag(thread, 'Active', 'Rejected');

        // Lock the forum thread
        await thread.setLocked(true);
      }
    } catch (error) {
      logger.warn('Applications', `Failed to update forum thread for application #${applicationId}: ${error}`);
    }
  }

  // DM the applicant
  try {
    const applicant = await interaction.client.users.fetch(application.applicant_user_id);

    if (transcriptBuffer) {
      const attachment = new AttachmentBuilder(transcriptBuffer, {
        name: `application-transcript-${characterName.toLowerCase()}.txt`,
      });
      await applicant.send({ content: messageToApplicant, files: [attachment] });
    } else {
      await applicant.send(messageToApplicant);
    }
  } catch (error) {
    logger.warn('Applications', `Failed to DM applicant for application #${applicationId}: ${error}`);
  }

  // Delete the app text channel
  if (application.channel_id) {
    try {
      const appChannel = guild.channels.cache.get(application.channel_id);
      if (appChannel) {
        await appChannel.delete();
      }
    } catch (error) {
      logger.warn('Applications', `Failed to delete app channel for application #${applicationId}: ${error}`);
    }
  }

  // Update application in DB
  db.prepare(
    `UPDATE applications
     SET status = 'rejected',
         resolved_at = datetime('now')
     WHERE id = ?`,
  ).run(applicationId);

  // Audit log
  await audit(interaction.user, 'rejected application', characterName);

  logger.info('Applications', `Application #${applicationId} rejected: ${characterName}`);

  await interaction.editReply({ content: 'Application rejected.' });
}

// ─── Helpers ──────────────────────────────────────────────────

/**
 * Swap a forum tag on a thread: remove `removeTagName`, add `addTagName`.
 */
async function swapForumTag(
  thread: AnyThreadChannel,
  removeTagName: string,
  addTagName: string,
): Promise<void> {
  const parent = thread.parent;
  if (!parent || !('availableTags' in parent)) return;

  const forum = parent as ForumChannel;
  const availableTags = forum.availableTags;

  const removeTag = availableTags.find((t) => t.name === removeTagName);
  const addTag = availableTags.find((t) => t.name === addTagName);

  if (!addTag) return;

  const currentTags = thread.appliedTags ?? [];
  const newTags = currentTags.filter((id) => id !== removeTag?.id);
  if (!newTags.includes(addTag.id)) {
    newTags.push(addTag.id);
  }

  await thread.setAppliedTags(newTags);
}

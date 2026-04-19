import {
  type Interaction,
  MessageFlags,
} from 'discord.js';
import type { BotClient } from '../types/index.js';
import { logger } from '../services/logger.js';
import { audit, alertOfficers } from '../services/auditLog.js';
import { getDatabase } from '../database/db.js';
import { startApplication } from '../functions/applications/startApplication.js';
import { submitApplication } from '../functions/applications/submitApplication.js';
import {
  activeSessions,
  enterEditMode,
  startSessionTimeout,
} from '../functions/applications/dmQuestionnaire.js';
import { voteOnApplication } from '../functions/applications/voteOnApplication.js';
import { acceptApplication, processAcceptModal } from '../functions/applications/acceptApplication.js';
import { rejectApplication, processRejectModal } from '../functions/applications/rejectApplication.js';
import {
  buttonHandlers,
  modalHandlers,
  userSelectHandlers,
  dispatch,
} from '../interactions/registry.js';

export default {
  name: 'interactionCreate',
  async execute(...args: unknown[]) {
    const interaction = args[0] as Interaction;

    if (interaction.isChatInputCommand()) {
      const client = interaction.client as BotClient;
      const command = client.commands.get(interaction.commandName);

      if (!command) {
        logger.warn('interaction', `Unknown command: ${interaction.commandName}`);
        return;
      }

      try {
        await command.execute(interaction);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error('interaction', `Command ${interaction.commandName} failed: ${err.message}`, err);

        const reply = { content: 'There was an error executing this command.', flags: MessageFlags.Ephemeral } as const;
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp(reply).catch(() => {});
        } else {
          await interaction.reply(reply).catch(() => {});
        }
      }
    }

    // Button handlers
    if (interaction.isButton()) {
      const customId = interaction.customId;

      if (await dispatch(buttonHandlers, 'button', interaction, customId)) return;

      try {
        // application:apply - "Apply Now" button
        if (customId === 'application:apply') {
          const success = await startApplication(interaction.user);

          if (success) {
            await interaction.reply({
              content: 'Check your DMs! I\'ve sent you the application questions.',
              flags: MessageFlags.Ephemeral,
            });
          } else {
            await interaction.reply({
              content: 'I was unable to send you a DM. Please make sure your DMs are open and try again.',
              flags: MessageFlags.Ephemeral,
            });
          }
        }

        // application:edit:{applicationId} - Edit an answer
        if (customId.startsWith('application:edit:')) {
          const applicationId = parseInt(customId.split(':')[2], 10);

          enterEditMode(interaction.user.id, applicationId);
          startSessionTimeout(interaction.user);

          try {
            await interaction.user.send('Which answer would you like to change? (enter the number)');
            await interaction.reply({
              content: 'Check your DMs to edit your answer.',
              flags: MessageFlags.Ephemeral,
            });
          } catch {
            activeSessions.delete(interaction.user.id);
            await interaction.reply({
              content: 'I was unable to send you a DM. Please make sure your DMs are open.',
              flags: MessageFlags.Ephemeral,
            });
          }
        }

        // application:confirm:{applicationId} - Submit the application
        if (customId.startsWith('application:confirm:')) {
          const applicationId = parseInt(customId.split(':')[2], 10);

          await interaction.reply({
            content: 'Submitting your application...',
            flags: MessageFlags.Ephemeral,
          });

          try {
            await submitApplication(interaction.client, applicationId, interaction.user);
            await interaction.editReply({
              content: 'Your application has been submitted! Officers will review it shortly.',
            });
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            logger.error('Applications', `Failed to submit application #${applicationId}: ${error.message}`, error);

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

        // application:cancel:{applicationId} - Cancel the application
        if (customId.startsWith('application:cancel:')) {
          const applicationId = parseInt(customId.split(':')[2], 10);
          const db = getDatabase();

          db.prepare('UPDATE applications SET status = ? WHERE id = ?')
            .run('abandoned', applicationId);

          // Clean up session if exists
          activeSessions.delete(interaction.user.id);

          try {
            await interaction.user.send('Your application has been cancelled. You can apply again anytime with /apply.');
          } catch {
            // DMs may be disabled
          }

          await interaction.reply({
            content: 'Application cancelled.',
            flags: MessageFlags.Ephemeral,
          });
        }

        // application_vote:{type}:{applicationId} - Vote on an application
        if (customId.startsWith('application_vote:')) {
          const parts = customId.split(':');
          const voteType = parts[1];
          const applicationId = parseInt(parts[2], 10);
          await voteOnApplication(interaction, applicationId, voteType);
        }

        // application:accept:{applicationId} - Accept button (show modal)
        if (customId.startsWith('application:accept:')) {
          await acceptApplication(interaction);
        }

        // application:reject:{applicationId} - Reject button (show modal)
        if (customId.startsWith('application:reject:')) {
          await rejectApplication(interaction);
        }

      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error('interaction', `Button handler failed (${customId}): ${err.message}`, err);

        const reply = { content: 'An error occurred handling this button.', flags: MessageFlags.Ephemeral } as const;
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp(reply).catch(() => {});
        } else {
          await interaction.reply(reply).catch(() => {});
        }
      }
    }

    // User select menu handlers
    if (interaction.isUserSelectMenu()) {
      const customId = interaction.customId;
      if (await dispatch(userSelectHandlers, 'select', interaction, customId)) return;
    }

    // Modal submit handlers
    if (interaction.isModalSubmit()) {
      const customId = interaction.customId;

      if (await dispatch(modalHandlers, 'modal', interaction, customId)) return;

      try {
        // application:modal:accept_message
        if (customId === 'application:modal:accept_message') {
          const message = interaction.fields.getTextInputValue('message');
          const db = getDatabase();
          db.prepare('INSERT OR REPLACE INTO default_messages (key, message) VALUES (?, ?)')
            .run('application_accept', message);

          await audit(interaction.user, 'updated accept message', message.substring(0, 100));
          await interaction.reply({
            content: 'Accept message updated.',
            flags: MessageFlags.Ephemeral,
          });
        }

        // application:modal:reject_message
        if (customId === 'application:modal:reject_message') {
          const message = interaction.fields.getTextInputValue('message');
          const db = getDatabase();
          db.prepare('INSERT OR REPLACE INTO default_messages (key, message) VALUES (?, ?)')
            .run('application_reject', message);

          await audit(interaction.user, 'updated reject message', message.substring(0, 100));
          await interaction.reply({
            content: 'Reject message updated.',
            flags: MessageFlags.Ephemeral,
          });
        }

        // application:modal:accept:{applicationId} - Process accept
        if (customId.startsWith('application:modal:accept:')) {
          await processAcceptModal(interaction);
        }

        // application:modal:reject:{applicationId} - Process reject
        if (customId.startsWith('application:modal:reject:')) {
          await processRejectModal(interaction);
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error('interaction', `Modal handler failed (${customId}): ${err.message}`, err);

        const reply = { content: 'An error occurred handling this modal.', flags: MessageFlags.Ephemeral } as const;
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp(reply).catch(() => {});
        } else {
          await interaction.reply(reply).catch(() => {});
        }
      }
    }
  },
};

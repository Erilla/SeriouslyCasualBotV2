import {
  type Interaction,
  type GuildMember,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} from 'discord.js';
import type { BotClient, TrialRow } from '../types/index.js';
import { config } from '../config.js';
import { logger } from '../services/logger.js';
import { updateRaiderDiscordUser } from '../functions/raids/updateRaiderDiscordUser.js';
import { ignoreCharacter } from '../functions/raids/ignoreCharacter.js';
import { sendAlertForRaidersWithNoUser } from '../functions/raids/sendAlertForRaidersWithNoUser.js';
import { audit } from '../services/auditLog.js';
import { getDatabase } from '../database/db.js';
import type { RaiderRow } from '../types/index.js';
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
import { extendTrial } from '../functions/trial-review/extendTrial.js';
import { markForPromotion } from '../functions/trial-review/markForPromotion.js';
import { closeTrial } from '../functions/trial-review/closeTrial.js';
import { changeTrialInfo } from '../functions/trial-review/changeTrialInfo.js';
import { createTrialReviewThread } from '../functions/trial-review/createTrialReviewThread.js';
import { updateLootResponse } from '../functions/loot/updateLootResponse.js';
import { updateLootPost } from '../functions/loot/updateLootPost.js';
import { generateLootPost } from '../functions/loot/generateLootPost.js';
import type { LootPostRow, LootResponseRow } from '../types/index.js';
import { getCachedPage, buildPageEmbed, buildPageButtons } from '../functions/pagination.js';

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

      try {
        // raider:confirm_link:{characterName}:{userId}
        if (customId.startsWith('raider:confirm_link:')) {
          const parts = customId.split(':');
          const characterName = parts[2];
          const userId = parts[3];

          const success = await updateRaiderDiscordUser(
            interaction.client,
            characterName,
            userId,
          );

          if (success) {
            await audit(interaction.user, 'confirmed raider link', `${characterName} -> <@${userId}>`);
            await interaction.update({
              content: `Linked **${characterName}** to <@${userId}>!`,
              components: [],
            });
          } else {
            await interaction.reply({
              content: `Failed to link **${characterName}**.`,
              flags: MessageFlags.Ephemeral,
            });
          }
        }

        // raider:reject_link:{characterName}
        if (customId.startsWith('raider:reject_link:')) {
          const characterName = customId.split(':')[2];

          try {
            await interaction.message.delete();
          } catch {
            // Message may already be deleted
          }

          // Post standard missing user alert (unmatched style)
          const db = getDatabase();
          const raider = db
            .prepare('SELECT * FROM raiders WHERE character_name = ?')
            .get(characterName) as RaiderRow | undefined;

          if (raider) {
            // Clear the old message_id since we deleted it
            db.prepare('UPDATE raiders SET message_id = NULL WHERE character_name = ?').run(characterName);
            await sendAlertForRaidersWithNoUser(interaction.client, [raider], []);
          }
        }

        // raider:ignore:{characterName}
        if (customId.startsWith('raider:ignore:')) {
          const characterName = customId.split(':')[2];
          const success = ignoreCharacter(characterName);

          if (success) {
            await audit(interaction.user, 'ignored character via button', characterName);

            try {
              await interaction.message.delete();
            } catch {
              // Message may already be deleted
            }

            await interaction.reply({
              content: `Ignored **${characterName}** and removed from raiders.`,
              flags: MessageFlags.Ephemeral,
            });
          } else {
            await interaction.reply({
              content: `Failed to ignore **${characterName}**.`,
              flags: MessageFlags.Ephemeral,
            });
          }
        }

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
            await interaction.editReply({
              content: 'There was an error submitting your application. Please contact an officer.',
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

        // trial:update_info:{trialId} - Show update info modal
        if (customId.startsWith('trial:update_info:')) {
          const member = interaction.member as GuildMember;
          if (!member.roles.cache.has(config.officerRoleId)) {
            await interaction.reply({
              content: 'You do not have permission to update trials.',
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          const trialId = parseInt(customId.split(':')[2], 10);
          const db = getDatabase();
          const trial = db
            .prepare('SELECT * FROM trials WHERE id = ?')
            .get(trialId) as TrialRow | undefined;

          if (!trial) {
            await interaction.reply({
              content: 'Trial not found.',
              flags: MessageFlags.Ephemeral,
            });
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

        // trial:extend:{trialId} - Extend trial by 1 week
        if (customId.startsWith('trial:extend:')) {
          const member = interaction.member as GuildMember;
          if (!member.roles.cache.has(config.officerRoleId)) {
            await interaction.reply({
              content: 'You do not have permission to extend trials.',
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          const trialId = parseInt(customId.split(':')[2], 10);
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });

          try {
            await extendTrial(interaction.client, trialId);
            await audit(interaction.user, 'extended trial', `#${trialId}`);
            await interaction.editReply({ content: 'Trial extended by 1 week.' });
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            await interaction.editReply({ content: `Failed to extend trial: ${error.message}` });
          }
        }

        // trial:mark_promote:{trialId} - Mark for promotion
        if (customId.startsWith('trial:mark_promote:')) {
          const member = interaction.member as GuildMember;
          if (!member.roles.cache.has(config.officerRoleId)) {
            await interaction.reply({
              content: 'You do not have permission to mark trials for promotion.',
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          const trialId = parseInt(customId.split(':')[2], 10);
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });

          try {
            await markForPromotion(interaction.client, trialId);
            await audit(interaction.user, 'marked trial for promotion', `#${trialId}`);
            await interaction.editReply({ content: 'Trial marked for promotion.' });
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            await interaction.editReply({ content: `Failed: ${error.message}` });
          }
        }

        // trial:close:{trialId} - Close trial
        if (customId.startsWith('trial:close:')) {
          const member = interaction.member as GuildMember;
          if (!member.roles.cache.has(config.officerRoleId)) {
            await interaction.reply({
              content: 'You do not have permission to close trials.',
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          const trialId = parseInt(customId.split(':')[2], 10);
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });

          try {
            await closeTrial(interaction.client, trialId);
            await audit(interaction.user, 'closed trial', `#${trialId}`);
            await interaction.editReply({ content: 'Trial closed.' });
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            await interaction.editReply({ content: `Failed to close trial: ${error.message}` });
          }
        }

        // page:{commandName}:{targetPage}:{totalPages} - Pagination navigation
        if (customId.startsWith('page:')) {
          const parts = customId.split(':');
          const commandName = parts[1];
          const page = parseInt(parts[2], 10);

          const cacheKey = `${commandName}:${interaction.message.id}`;
          const data = getCachedPage(cacheKey, page);

          if (!data) {
            await interaction.reply({
              content: 'This list has expired. Please run the command again.',
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          const embed = buildPageEmbed(data.title, data.content, page, data.totalPages);
          const buttons = buildPageButtons(commandName, page, data.totalPages);
          await interaction.update({
            embeds: [embed],
            components: buttons ? [buttons] : [],
          });
        }

        // loot:{responseType}:{bossId} - Loot priority button
        if (customId.startsWith('loot:')) {
          const [, responseType, bossIdStr] = customId.split(':');
          const bossId = parseInt(bossIdStr, 10);

          // Validate raider exists
          const db = getDatabase();
          const raider = db
            .prepare('SELECT * FROM raiders WHERE discord_user_id = ?')
            .get(interaction.user.id) as RaiderRow | undefined;

          if (!raider) {
            await interaction.reply({
              content: 'Could not find a character linked to your Discord account. Please contact an officer!',
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          await updateLootResponse(interaction.client, responseType, bossId, interaction.user.id);

          // Build updated post data for the interaction update
          const lootPost = db
            .prepare('SELECT * FROM loot_posts WHERE boss_id = ?')
            .get(bossId) as LootPostRow | undefined;

          if (lootPost) {
            const responses = db
              .prepare('SELECT * FROM loot_responses WHERE loot_post_id = ?')
              .all(lootPost.id) as LootResponseRow[];

            const raiders = db
              .prepare('SELECT * FROM raiders WHERE discord_user_id IS NOT NULL')
              .all() as RaiderRow[];

            const userToCharacter = new Map<string, string>();
            for (const r of raiders) {
              if (r.discord_user_id && !userToCharacter.has(r.discord_user_id)) {
                userToCharacter.set(r.discord_user_id, r.character_name);
              }
            }

            const grouped: Record<string, string[]> = {
              major: [],
              minor: [],
              wantIn: [],
              wantOut: [],
            };

            for (const response of responses) {
              const charName = userToCharacter.get(response.user_id) ?? 'Unknown';
              if (grouped[response.response_type]) {
                grouped[response.response_type].push(charName);
              }
            }

            const playerResponses = {
              major: grouped.major.length > 0 ? grouped.major.join('\n') : '*None*',
              minor: grouped.minor.length > 0 ? grouped.minor.join('\n') : '*None*',
              wantIn: grouped.wantIn.length > 0 ? grouped.wantIn.join('\n') : '*None*',
              wantOut: grouped.wantOut.length > 0 ? grouped.wantOut.join('\n') : '*None*',
            };

            const postData = generateLootPost(lootPost.boss_name, bossId, playerResponses);
            await interaction.update(postData);
          }
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

      try {
        // raider:select_user:{characterName}
        if (customId.startsWith('raider:select_user:')) {
          const characterName = customId.split(':')[2];
          const selectedUserId = interaction.values[0];

          const success = await updateRaiderDiscordUser(
            interaction.client,
            characterName,
            selectedUserId,
          );

          if (success) {
            await audit(interaction.user, 'linked raider via select', `${characterName} -> <@${selectedUserId}>`);

            try {
              await interaction.message.delete();
            } catch {
              // Message may already be deleted
            }

            await interaction.reply({
              content: `Linked **${characterName}** to <@${selectedUserId}>.`,
              flags: MessageFlags.Ephemeral,
            });
          } else {
            await interaction.reply({
              content: `Failed to link **${characterName}**.`,
              flags: MessageFlags.Ephemeral,
            });
          }
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error('interaction', `Select menu handler failed (${customId}): ${err.message}`, err);

        const reply = { content: 'An error occurred handling this selection.', flags: MessageFlags.Ephemeral } as const;
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp(reply).catch(() => {});
        } else {
          await interaction.reply(reply).catch(() => {});
        }
      }
    }

    // Modal submit handlers
    if (interaction.isModalSubmit()) {
      const customId = interaction.customId;

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

        // trial:modal:create - Create a new trial review thread
        if (customId === 'trial:modal:create') {
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
            await audit(interaction.user, 'created trial', `${characterName} as ${role} (#${trial.id})`);
            await interaction.editReply({
              content: `Trial created for **${characterName}**. Thread: <#${trial.thread_id}>`,
            });
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            logger.error('Trials', `Failed to create trial: ${error.message}`, error);
            await interaction.editReply({ content: `Failed to create trial: ${error.message}` });
          }
        }

        // trial:modal:update:{trialId} - Update trial info
        if (customId.startsWith('trial:modal:update:')) {
          const trialId = parseInt(customId.split(':')[3], 10);
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
            const trial = db
              .prepare('SELECT * FROM trials WHERE id = ?')
              .get(trialId) as TrialRow | undefined;

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
            await audit(
              interaction.user,
              'updated trial info via modal',
              `${trial.character_name} (#${trialId})`,
            );
            await interaction.editReply({ content: 'Trial info updated.' });
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            await interaction.editReply({
              content: `Failed to update trial: ${error.message}`,
            });
          }
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

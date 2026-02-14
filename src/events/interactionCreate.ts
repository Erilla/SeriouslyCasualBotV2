import {
    type Interaction,
    MessageFlags,
    ActionRowBuilder,
    UserSelectMenuBuilder,
    ButtonBuilder,
    ButtonStyle,
} from 'discord.js';
import type { BotClient, BotEvent } from '../types/index.js';
import { logger } from '../services/logger.js';
import { auditLog } from '../services/auditLog.js';
import { updateRaiderDiscordUser, unmatchRaider } from '../functions/raids/updateRaiderDiscordUser.js';
import { ignoreCharacter } from '../functions/raids/ignoreCharacter.js';
import { getBooleanSetting } from '../functions/settings/getSetting.js';
import { startApplication } from '../functions/applications/startApplication.js';
import { submitApplication } from '../functions/applications/submitApplication.js';
import { cancelSession } from '../functions/applications/dmQuestionnaire.js';
import { voteOnApplication } from '../functions/applications/voteOnApplication.js';

const event: BotEvent = {
    name: 'interactionCreate',

    async execute(...args: unknown[]) {
        const interaction = args[0] as Interaction;

        // --- Slash Commands ---
        if (interaction.isChatInputCommand()) {
            const client = interaction.client as BotClient;
            const command = client.commands.get(interaction.commandName);

            if (!command) {
                await logger.warn(`Unknown command: ${interaction.commandName}`);
                return;
            }

            try {
                await auditLog.logCommand(interaction);
                await command.execute(interaction);
            } catch (error) {
                await logger.error(
                    `Error executing /${interaction.commandName}`,
                    error
                );

                const reply = {
                    content: 'There was an error executing this command.',
                    flags: MessageFlags.Ephemeral,
                } as const;

                if (interaction.replied || interaction.deferred) {
                    await interaction.followUp(reply);
                } else {
                    await interaction.reply(reply);
                }
            }
            return;
        }

        // --- Button Interactions ---
        if (interaction.isButton()) {
            try {
                const customId = interaction.customId;

                // Ignore missing character button (from raider sync alerts)
                if (customId.startsWith('ignore_missing_character:')) {
                    const characterName = customId.split(':')[1];
                    if (ignoreCharacter(characterName)) {
                        await interaction.update({ content: `${characterName} — Ignored`, components: [] });
                    } else {
                        await interaction.reply({ content: `Failed to ignore ${characterName}`, flags: MessageFlags.Ephemeral });
                    }
                    return;
                }

                // Unmatch auto-linked raider — revert to manual match UI
                if (customId.startsWith('unmatch_raider:')) {
                    const characterName = customId.split(':')[1];
                    unmatchRaider(characterName);

                    const selectRow = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
                        new UserSelectMenuBuilder()
                            .setCustomId(`missing_user_select:${characterName}`)
                            .setPlaceholder(`Select user for ${characterName}`)
                            .setMinValues(1)
                            .setMaxValues(1),
                    );
                    const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
                        new ButtonBuilder()
                            .setCustomId(`ignore_missing_character:${characterName}`)
                            .setLabel('Ignore character')
                            .setStyle(ButtonStyle.Danger),
                    );

                    await interaction.update({
                        content: characterName,
                        components: [selectRow, buttonRow],
                    });
                    return;
                }

                // "Apply Now" button
                if (customId === 'application:apply') {
                    if (!getBooleanSetting('use_custom_applications')) {
                        await interaction.reply({
                            content: 'Applications are currently handled externally.',
                            flags: MessageFlags.Ephemeral,
                        });
                        return;
                    }

                    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                    const error = await startApplication(interaction.user);
                    if (error) {
                        await interaction.editReply({ content: error });
                    } else {
                        await interaction.editReply({ content: 'Check your DMs! I\'ve sent you the first question.' });
                    }
                    return;
                }

                // Application confirm/cancel buttons (from DM confirmation)
                if (customId === 'application:confirm') {
                    await interaction.deferUpdate();
                    const error = await submitApplication(interaction.client, interaction.user);
                    if (error) {
                        await interaction.followUp({ content: error });
                    } else {
                        await interaction.editReply({
                            content: 'Your application has been submitted! An officer will review it soon.',
                            embeds: [],
                            components: [],
                        });
                    }
                    return;
                }

                if (customId === 'application:cancel') {
                    cancelSession(interaction.user.id);
                    await interaction.update({
                        content: 'Your application has been cancelled. You can start a new one by clicking the Apply button.',
                        embeds: [],
                        components: [],
                    });
                    return;
                }

                // Application voting buttons
                if (customId.startsWith('application_vote:')) {
                    const voteType = customId.split(':')[1];
                    await voteOnApplication(interaction, voteType);
                    return;
                }

                await logger.debug(`Button clicked: ${customId}`);
            } catch (error) {
                await logger.error(`Error handling button: ${interaction.customId}`, error);
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ content: 'Something went wrong.', flags: MessageFlags.Ephemeral });
                }
            }
            return;
        }

        // --- Modal Submissions ---
        if (interaction.isModalSubmit()) {
            // TODO: Route modal submissions (Task 7+)
            await logger.debug(`Modal submitted: ${interaction.customId}`);
            await interaction.reply({
                content: 'This feature is not yet available.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        // --- Select Menu Interactions ---
        if (interaction.isUserSelectMenu()) {
            try {
                const customId = interaction.customId;

                // User select for missing raider assignment
                if (customId.startsWith('missing_user_select:')) {
                    const characterName = customId.split(':')[1];
                    const selectedUserId = interaction.values[0];
                    if (updateRaiderDiscordUser(characterName, selectedUserId)) {
                        await interaction.update({ content: `${characterName} — Linked to <@${selectedUserId}>`, components: [] });
                    } else {
                        await interaction.reply({ content: `Failed to update ${characterName}`, flags: MessageFlags.Ephemeral });
                    }
                    return;
                }

                await logger.debug(`User select menu: ${customId}`);
            } catch (error) {
                await logger.error('Error handling user select menu', error);
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ content: 'Something went wrong.', flags: MessageFlags.Ephemeral });
                }
            }
            return;
        }

        if (interaction.isStringSelectMenu()) {
            await logger.debug(`String select menu: ${interaction.customId}`);
            await interaction.reply({
                content: 'This feature is not yet available.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }
    },
};

export default event;

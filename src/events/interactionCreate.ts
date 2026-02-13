import { type Interaction, MessageFlags } from 'discord.js';
import type { BotClient, BotEvent } from '../types/index.js';
import { logger } from '../services/logger.js';
import { auditLog } from '../services/auditLog.js';

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
            // TODO: Route button interactions (Task 5+)
            await logger.debug(`Button clicked: ${interaction.customId}`);
            return;
        }

        // --- Modal Submissions ---
        if (interaction.isModalSubmit()) {
            // TODO: Route modal submissions (Task 5+)
            await logger.debug(`Modal submitted: ${interaction.customId}`);
            return;
        }

        // --- Select Menu Interactions ---
        if (interaction.isStringSelectMenu() || interaction.isUserSelectMenu()) {
            // TODO: Route select menu interactions (Task 4+)
            await logger.debug(`Select menu: ${interaction.customId}`);
            return;
        }
    },
};

export default event;

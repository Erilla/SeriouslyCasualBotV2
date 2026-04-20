import type { Interaction } from 'discord.js';
import { MessageFlags } from 'discord.js';
import type { BotClient } from '../types/index.js';
import { logger } from '../services/logger.js';
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

        const reply = {
          content: 'There was an error executing this command.',
          flags: MessageFlags.Ephemeral,
        } as const;
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp(reply).catch(() => {});
        } else {
          await interaction.reply(reply).catch(() => {});
        }
      }
      return;
    }

    if (interaction.isButton()) {
      await dispatch(buttonHandlers, 'button', interaction, interaction.customId);
      return;
    }

    if (interaction.isUserSelectMenu()) {
      await dispatch(userSelectHandlers, 'select', interaction, interaction.customId);
      return;
    }

    if (interaction.isModalSubmit()) {
      await dispatch(modalHandlers, 'modal', interaction, interaction.customId);
      return;
    }
  },
};

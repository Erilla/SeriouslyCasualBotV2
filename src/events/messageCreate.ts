import type { Message } from 'discord.js';
import { handleDmMessage } from '../functions/applications/dmQuestionnaire.js';

export default {
  name: 'messageCreate',
  async execute(...args: unknown[]) {
    const message = args[0] as Message;

    // Ignore bot messages
    if (message.author.bot) return;

    // Handle DMs - check if this is an application response
    if (!message.guild) {
      await handleDmMessage(message);
    }
  },
};

import type { Message } from 'discord.js';
import { handleDmMessage } from '../functions/applications/dmQuestionnaire.js';
import { harvestLinkedCharacters } from '../functions/applications/harvestLinkedCharacters.js';

export default {
  name: 'messageCreate',
  async execute(...args: unknown[]) {
    const message = args[0] as Message;

    // Ignore bot messages. Stays the first guard: a webhook or another bot
    // pasting a character URL is not the applicant volunteering one.
    if (message.author.bot) return;

    // Handle DMs - check if this is an application response
    if (!message.guild) {
      await handleDmMessage(message);
      return;
    }

    // Guild messages: pick up character links dropped into an application
    // conversation. Parses before any database work, so a message with no URL
    // in it costs one regex sweep and nothing else.
    await harvestLinkedCharacters(message);
  },
};

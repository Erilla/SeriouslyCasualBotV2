import { type Message, ChannelType } from 'discord.js';
import type { BotEvent } from '../types/index.js';
import { handleDmResponse } from '../functions/applications/dmQuestionnaire.js';
import { logger } from '../services/logger.js';

const event: BotEvent = {
    name: 'messageCreate',

    async execute(...args: unknown[]) {
        const message = args[0] as Message;

        // Ignore bot messages
        if (message.author.bot) return;

        // Only handle DMs
        if (message.channel.type !== ChannelType.DM) return;

        try {
            const handled = await handleDmResponse(message);
            if (!handled) {
                // No active application session - ignore DM
                return;
            }
        } catch (error) {
            await logger.error('[MessageCreate] Error handling DM', error);
        }
    },
};

export default event;

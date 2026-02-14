import {
    type Client,
    type TextChannel,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} from 'discord.js';
import { getChannel } from '../setup/getChannel.js';
import { asSendable } from '../../utils.js';
import type { AutoMatchResult } from './autoMatchRaiders.js';

/**
 * Post auto-matched raider alerts to the bot_setup channel.
 * Each matched raider gets a message showing the link with an "Unmatch" button.
 */
export async function sendAutoMatchAlerts(
    client: Client,
    matched: AutoMatchResult['matched'],
): Promise<void> {
    if (matched.length === 0) return;

    const channelId = getChannel('bot_setup');
    if (!channelId) return;

    const channel = await client.channels.fetch(channelId);
    const sendable = asSendable(channel);
    if (!sendable) return;

    const textChannel = sendable as TextChannel;

    for (const { characterName, discordUserId } of matched) {
        const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`unmatch_raider:${characterName}`)
                .setLabel('Unmatch')
                .setStyle(ButtonStyle.Danger),
        );

        await textChannel.send({
            content: `${characterName} — Linked to <@${discordUserId}>`,
            components: [buttonRow],
        });
    }
}

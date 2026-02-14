import {
    type Client,
    type TextChannel,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} from 'discord.js';
import { fetchTextChannel, sendInBatches } from '../../utils.js';
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

    const textChannel = await fetchTextChannel(client, 'bot_setup');
    if (!textChannel) return;

    const payloads = matched.map(({ characterName, discordUserId }) => {
        const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`unmatch_raider:${characterName}`)
                .setLabel('Unmatch')
                .setStyle(ButtonStyle.Danger),
        );

        return {
            content: `${characterName} — Linked to <@${discordUserId}>`,
            components: [buttonRow],
        };
    });

    await sendInBatches(textChannel as TextChannel, payloads);
}

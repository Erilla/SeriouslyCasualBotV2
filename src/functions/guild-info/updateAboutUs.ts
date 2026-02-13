import {
    type Client,
    type TextChannel,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    Colors,
} from 'discord.js';
import { getChannel } from '../setup/getChannel.js';
import { logger } from '../../services/logger.js';
import { asSendable } from '../../utils.js';
import { loadJson } from '../../utils.js';

interface AboutUsData {
    title: string;
    content: string;
    links: Array<{
        label: string;
        url: string;
        emoji: string;
    }>;
}

const aboutUs = loadJson<AboutUsData>('../../data/aboutus.json');

/**
 * Post the About Us embed to the guild_info channel.
 */
export async function updateAboutUs(client: Client): Promise<void> {
    const channelId = getChannel('guild_info');
    if (!channelId) return;

    const channel = await client.channels.fetch(channelId);
    const sendable = asSendable(channel);
    if (!sendable) return;

    const embed = new EmbedBuilder()
        .setTitle(aboutUs.title)
        .setDescription(aboutUs.content)
        .setColor(Colors.Green);

    const row = new ActionRowBuilder<ButtonBuilder>();
    for (const link of aboutUs.links) {
        row.addComponents(
            new ButtonBuilder()
                .setLabel(link.label)
                .setStyle(ButtonStyle.Link)
                .setURL(link.url)
                .setEmoji(link.emoji)
        );
    }

    await (sendable as TextChannel).send({ embeds: [embed], components: [row] });
    await logger.debug('[GuildInfo] Posted About Us embed');
}

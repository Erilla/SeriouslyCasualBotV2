import {
    type Client,
    type TextChannel,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    Colors,
} from 'discord.js';
import { logger } from '../../services/logger.js';
import { fetchTextChannel, loadJson } from '../../utils.js';

interface AboutUsData {
    title: string;
    content: string;
    links: Array<{
        label: string;
        url: string;
        emoji: string;
    }>;
}

const aboutUs = loadJson<AboutUsData>('data/aboutus.json');

/**
 * Post the About Us embed to the guild_info channel.
 */
export async function updateAboutUs(client: Client, channel?: TextChannel): Promise<void> {
    const textChannel = channel ?? await fetchTextChannel(client, 'guild_info');
    if (!textChannel) return;

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

    await textChannel.send({ embeds: [embed], components: [row] });
    await logger.debug('[GuildInfo] Posted About Us embed');
}

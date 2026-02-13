import {
    type Client,
    type TextChannel,
    EmbedBuilder,
    Colors,
} from 'discord.js';
import { getChannel } from '../setup/getChannel.js';
import { getDatabase } from '../../database/database.js';
import { asSendable, loadJson } from '../../utils.js';
import { logger } from '../../services/logger.js';
import type { OverlordRow } from '../../types/index.js';

interface RecruitmentData {
    title: string;
    content: Array<{
        title: string;
        body: string;
    }>;
}

const recruitment = loadJson<RecruitmentData>('data/recruitment.json');

/**
 * Post the Recruitment embed to the guild_info channel.
 * Replaces {{OVERLORDS}} with mentions of all overlords from the DB.
 */
export async function updateRecruitment(client: Client): Promise<void> {
    const channelId = getChannel('guild_info');
    if (!channelId) return;

    const channel = await client.channels.fetch(channelId);
    const sendable = asSendable(channel);
    if (!sendable) return;

    // Get overlords for the {{OVERLORDS}} token
    const db = getDatabase();
    const overlords = db.prepare('SELECT * FROM overlords').all() as OverlordRow[];
    const overlordsString = overlords.map((o) => `<@${o.discord_user_id}>`).join(' / ') || '*None configured*';

    const embed = new EmbedBuilder()
        .setTitle(recruitment.title)
        .setColor(Colors.Green);

    for (let i = 0; i < recruitment.content.length; i++) {
        const section = recruitment.content[i];
        let body = section.body;

        if (body.includes('{{OVERLORDS}}')) {
            body = body.replace('{{OVERLORDS}}', overlordsString);
        }

        embed.addFields({ name: section.title, value: body });

        // Add spacer between sections (except after last)
        if (i < recruitment.content.length - 1) {
            embed.addFields({ name: '\u200b', value: '\u200b' });
        }
    }

    await (sendable as TextChannel).send({
        embeds: [embed],
        allowedMentions: { users: [] },
    });
    await logger.debug('[GuildInfo] Posted Recruitment embed');
}

import {
    type Client,
    type TextChannel,
    EmbedBuilder,
    Colors,
} from 'discord.js';
import { fetchTextChannel, loadJson } from '../../utils.js';
import { logger } from '../../services/logger.js';

interface ScheduleData {
    title: string;
    raidDays: string[];
    raidTimes: string[];
    timeZone: string;
}

const schedule = loadJson<ScheduleData>('data/schedule.json');

/**
 * Post the Raid Schedule embed to the guild_info channel.
 */
export async function updateSchedule(client: Client, channel?: TextChannel): Promise<void> {
    const textChannel = channel ?? await fetchTextChannel(client, 'guild_info');
    if (!textChannel) return;

    let dayColumn = '';
    let timeColumn = '';
    for (const day of schedule.raidDays) {
        dayColumn += day + '\n';
        timeColumn += schedule.raidTimes[0] + '\n';
    }

    const embed = new EmbedBuilder()
        .setTitle(schedule.title)
        .addFields(
            { name: 'Day', value: dayColumn.trim(), inline: true },
            { name: '\u200b', value: '\u200b', inline: true },
            { name: 'Time', value: timeColumn.trim(), inline: true },
        )
        .setFooter({ text: schedule.timeZone })
        .setColor(Colors.Green);

    await textChannel.send({ embeds: [embed] });
    await logger.debug('[GuildInfo] Posted Schedule embed');
}

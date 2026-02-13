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
import { getRaidRankings, getRaidStaticData, type RaidStaticData } from '../../services/raiderio.js';

interface AchievementsData {
    title: string;
    achievements: Array<{
        raid: string;
        progress: string;
        result: string;
        expansion: number;
    }>;
}

const achievementsData = loadJson<AchievementsData>('data/achievements.json');

// Minimum expansion ID for Raider.io API data (older ones use manual JSON data)
const RAIDERIO_MIN_EXPANSION = 6;

/**
 * Build and post (or edit) the achievements embed.
 * Combines manual data from achievements.json with live Raider.io data.
 */
export async function updateAchievements(client: Client): Promise<void> {
    const channelId = getChannel('guild_info');
    if (!channelId) return;

    const channel = await client.channels.fetch(channelId);
    const sendable = asSendable(channel);
    if (!sendable) return;

    const textChannel = sendable as TextChannel;

    let raidsColumn = '';
    let progressColumn = '';
    let rankingColumn = '';

    // Build manual achievements (old expansions from JSON)
    for (let expansion = 4; expansion < RAIDERIO_MIN_EXPANSION; expansion++) {
        const manual = buildManualAchievements(expansion);
        raidsColumn = manual.raids + raidsColumn;
        progressColumn = manual.progress + progressColumn;
        rankingColumn = manual.ranking + rankingColumn;
    }

    // Build dynamic achievements from Raider.io
    let expansion = RAIDERIO_MIN_EXPANSION;
    while (true) {
        const staticData = await getRaidStaticData(expansion);
        if (!staticData) break;

        const dynamic = await buildDynamicAchievements(staticData);
        if (dynamic) {
            raidsColumn = dynamic.raids + '\n' + raidsColumn;
            progressColumn = dynamic.progress + '\n' + progressColumn;
            rankingColumn = dynamic.ranking + '\n' + rankingColumn;
        }

        expansion++;
    }

    const embed = new EmbedBuilder()
        .setTitle(achievementsData.title)
        .addFields(
            { name: 'Raid', value: raidsColumn.trim() || 'No data', inline: true },
            { name: '\u200b', value: progressColumn.trim() || '\u200b', inline: true },
            { name: '\u200b', value: rankingColumn.trim() || '\u200b', inline: true },
        )
        .setColor(Colors.Green);

    // Try to edit existing message, otherwise send new one
    const db = getDatabase();
    const stored = db.prepare('SELECT value FROM guild_info WHERE key = ?').get('achievements_message_id') as { value: string } | undefined;

    if (stored) {
        try {
            const existingMessage = await textChannel.messages.fetch(stored.value);
            await existingMessage.edit({ embeds: [embed] });
            await logger.debug('[GuildInfo] Updated achievements embed');
            return;
        } catch {
            // Message not found, send a new one
        }
    }

    const message = await textChannel.send({ embeds: [embed] });
    db.prepare('INSERT OR REPLACE INTO guild_info (key, value) VALUES (?, ?)').run('achievements_message_id', message.id);
    await logger.debug('[GuildInfo] Posted new achievements embed');
}

function buildManualAchievements(expansion: number): { raids: string; progress: string; ranking: string } {
    const achievements = achievementsData.achievements.filter((a) => a.expansion === expansion);

    let raids = '';
    let progress = '';
    let ranking = '';

    for (const achieve of achievements) {
        raids = achieve.raid + '\n' + raids;
        progress = achieve.progress + '\n' + progress;
        ranking = achieve.result + '\n' + ranking;
    }

    return { raids, progress, ranking };
}

async function buildDynamicAchievements(staticData: RaidStaticData): Promise<{ raids: string; progress: string; ranking: string } | null> {
    // Sort raids by end date (oldest first, current last)
    const sortedRaids = [...staticData.raids].sort((a, b) => {
        if (a.ends.eu === null) return 1;
        if (b.ends.eu === null) return -1;
        return a.ends.eu > b.ends.eu ? 1 : -1;
    });

    let raids = '';
    let progress = '';
    let ranking = '';

    for (const raid of sortedRaids) {
        const rankingsData = await getRaidRankings(raid.slug);
        if (!rankingsData?.raidRankings?.length) continue;

        // Pick the ranking entry with most bosses killed
        let bestRanking = rankingsData.raidRankings[0];
        if (rankingsData.raidRankings.length > 2) {
            for (const rr of rankingsData.raidRankings) {
                if (rr.encountersDefeated.length > bestRanking.encountersDefeated.length) {
                    bestRanking = rr;
                }
            }
        }

        const killedBosses = bestRanking.encountersDefeated.length;
        if (!killedBosses) continue;

        const totalBosses = raid.encounters.length;
        const tierEndDate = raid.ends.eu;
        const isCE = checkIsCuttingEdge(raid, tierEndDate, bestRanking, killedBosses, totalBosses);
        const worldRanking = getWorldRanking(tierEndDate, bestRanking.rank, isCE);

        raids = raid.name + '\n' + raids;
        progress = `${killedBosses}/${totalBosses}M` + '\n' + progress;
        ranking = worldRanking + '\n' + ranking;
    }

    if (!raids) return null;
    return { raids, progress, ranking };
}

function checkIsCuttingEdge(
    raid: RaidStaticData['raids'][0],
    tierEndDate: string | null,
    raidRanking: { encountersDefeated: Array<{ slug: string; firstDefeated: string }> },
    killedBosses: number,
    totalBosses: number,
): boolean {
    // Fated raids didn't have CE
    if (raid.name.startsWith('Fated')) return false;

    const lastBossSlug = raid.encounters[raid.encounters.length - 1].slug;
    const firstDefeated = raidRanking.encountersDefeated.find(
        (e) => e.slug === lastBossSlug,
    )?.firstDefeated;

    if (!firstDefeated) return false;

    return (
        (tierEndDate !== null && Date.parse(firstDefeated) < Date.parse(tierEndDate)) ||
        (tierEndDate === null && killedBosses === totalBosses)
    );
}

function getWorldRanking(tierEndDate: string | null, rank: number, isCE: boolean): string {
    if (!isCE && tierEndDate === null) {
        return '**In Progress**';
    }
    return `${isCE ? '**CE**' : '\u200b'} WR ${rank}`;
}

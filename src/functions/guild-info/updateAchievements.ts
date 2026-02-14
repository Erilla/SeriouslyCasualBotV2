import {
    type Client,
    type TextChannel,
    EmbedBuilder,
    Colors,
} from 'discord.js';
import { getDatabase } from '../../database/database.js';
import { fetchTextChannel, loadJson } from '../../utils.js';
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
// Range of expansion IDs to fetch in parallel from Raider.io
const RAIDERIO_MAX_EXPANSION = 15;

/**
 * Build and post (or edit) the achievements embed.
 * Combines manual data from achievements.json with live Raider.io data.
 */
export async function updateAchievements(client: Client, channel?: TextChannel): Promise<void> {
    const textChannel = channel ?? await fetchTextChannel(client, 'guild_info');
    if (!textChannel) return;

    const raidsLines: string[] = [];
    const progressLines: string[] = [];
    const rankingLines: string[] = [];

    // Build manual achievements (old expansions from JSON)
    for (let expansion = 4; expansion < RAIDERIO_MIN_EXPANSION; expansion++) {
        const manual = buildManualAchievements(expansion);
        raidsLines.unshift(manual.raids);
        progressLines.unshift(manual.progress);
        rankingLines.unshift(manual.ranking);
    }

    // Fetch all expansion static data in parallel
    const expansionIds = Array.from(
        { length: RAIDERIO_MAX_EXPANSION - RAIDERIO_MIN_EXPANSION + 1 },
        (_, i) => RAIDERIO_MIN_EXPANSION + i,
    );
    const staticResults = await Promise.all(
        expansionIds.map((id) => getRaidStaticData(id)),
    );

    // Build dynamic achievements from results (in order)
    for (const staticData of staticResults) {
        if (!staticData) continue;
        const dynamic = await buildDynamicAchievements(staticData);
        if (dynamic) {
            raidsLines.unshift(dynamic.raids);
            progressLines.unshift(dynamic.progress);
            rankingLines.unshift(dynamic.ranking);
        }
    }

    const raidsColumn = raidsLines.join('\n');
    const progressColumn = progressLines.join('\n');
    const rankingColumn = rankingLines.join('\n');

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

export function buildManualAchievements(expansion: number): { raids: string; progress: string; ranking: string } {
    const achievements = achievementsData.achievements.filter((a) => a.expansion === expansion);

    const raids: string[] = [];
    const progress: string[] = [];
    const ranking: string[] = [];

    for (const achieve of achievements) {
        raids.unshift(achieve.raid);
        progress.unshift(achieve.progress);
        ranking.unshift(achieve.result);
    }

    return { raids: raids.join('\n'), progress: progress.join('\n'), ranking: ranking.join('\n') };
}

async function buildDynamicAchievements(staticData: RaidStaticData): Promise<{ raids: string; progress: string; ranking: string } | null> {
    // Sort raids by end date (oldest first, current last)
    const sortedRaids = [...staticData.raids].sort((a, b) => {
        if (a.ends.eu === null) return 1;
        if (b.ends.eu === null) return -1;
        return a.ends.eu > b.ends.eu ? 1 : -1;
    });

    // Fetch all rankings in parallel
    const raidEntries = await Promise.all(
        sortedRaids.map(async (raid) => ({
            raid,
            rankingsData: await getRaidRankings(raid.slug),
        })),
    );

    const raids: string[] = [];
    const progress: string[] = [];
    const ranking: string[] = [];

    for (let i = 0; i < raidEntries.length; i++) {
        const { raid, rankingsData } = raidEntries[i];
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
        const tierEnded = tierEndDate !== null && Date.parse(tierEndDate) < Date.now();
        const isCE = checkIsCuttingEdge(raid, tierEndDate, bestRanking, killedBosses, totalBosses);

        let worldRanking: string;
        if (!tierEnded && killedBosses < totalBosses) {
            worldRanking = '**In Progress**';
        } else if (!tierEnded && killedBosses === totalBosses) {
            // Full clear on current tier - show rank but no CE yet
            worldRanking = `WR ${bestRanking.rank}`;
        } else {
            worldRanking = `${isCE ? '**CE**' : '\u200b'} WR ${bestRanking.rank}`;
        }

        raids.unshift(raid.name);
        progress.unshift(`${killedBosses}/${totalBosses}M`);
        ranking.unshift(worldRanking);
    }

    if (raids.length === 0) return null;
    return { raids: raids.join('\n'), progress: progress.join('\n'), ranking: ranking.join('\n') };
}

export function checkIsCuttingEdge(
    raid: RaidStaticData['raids'][0],
    tierEndDate: string | null,
    raidRanking: { encountersDefeated: Array<{ slug: string; firstDefeated: string }> },
    killedBosses: number,
    totalBosses: number,
): boolean {
    // Fated raids didn't have CE
    if (raid.name.startsWith('Fated')) return false;

    // Tier must have ended to determine CE
    if (tierEndDate === null || Date.parse(tierEndDate) > Date.now()) return false;

    // Must have killed all bosses
    if (killedBosses < totalBosses) return false;

    // Last boss must have been killed before the tier ended
    const lastBossSlug = raid.encounters[raid.encounters.length - 1].slug;
    const firstDefeated = raidRanking.encountersDefeated.find(
        (e) => e.slug === lastBossSlug,
    )?.firstDefeated;

    if (!firstDefeated) return false;

    return Date.parse(firstDefeated) < Date.parse(tierEndDate);
}

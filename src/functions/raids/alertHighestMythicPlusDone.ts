import { Buffer } from 'node:buffer';
import type { Client, TextChannel } from 'discord.js';
import { getChannel } from '../setup/getChannel.js';
import { asSendable } from '../../utils.js';
import { logger } from '../../services/logger.js';
import { getHistoricalData, type WowAuditCharacterData } from '../../services/wowaudit.js';

/**
 * Build the M+ dungeons report message from WoW Audit historical data.
 * Returns a Discord message payload with a text file attachment.
 */
export async function getPreviousWeekMythicPlusMessage(
    historicData?: WowAuditCharacterData[] | null,
): Promise<{ content: string; files: Array<{ attachment: Buffer; name: string; description: string }> }> {
    if (!historicData) {
        historicData = await getHistoricalData();
    }

    if (!historicData) {
        return { content: 'Highest Mythic+ Runs last week\nNo data available — check WoW Audit API is configured.', files: [] };
    }

    const dungeonsDone = historicData.map((character) => ({
        characterName: character.name,
        dungeonsDone: character.data?.dungeons_done
            ?.map((d) => Number(d.level))
            .sort((a, b) => b - a) ?? null,
    }));

    dungeonsDone.sort((a, b) =>
        a.characterName.toUpperCase() < b.characterName.toUpperCase() ? -1
            : a.characterName.toUpperCase() > b.characterName.toUpperCase() ? 1 : 0,
    );

    let content = '';
    for (const character of dungeonsDone) {
        const dungeons = character.dungeonsDone?.join(',') ?? 'No Data';
        content += `${character.characterName}: [${dungeons}]\n`;
    }

    const buffer = Buffer.from(content, 'utf-8');
    const today = new Date().toISOString().split('T')[0];

    return {
        content: 'Highest Mythic+ Runs last week',
        files: [{
            attachment: buffer,
            name: `highest_mythicplus_${today}.txt`,
            description: 'Mythic+ done by raiders last week',
        }],
    };
}

/**
 * Build the Great Vault report message from WoW Audit historical data.
 * Returns a Discord message payload with a text file attachment.
 */
export async function getPreviousWeeklyGreatVaultMessage(
    historicData?: WowAuditCharacterData[] | null,
): Promise<{ content: string; files: Array<{ attachment: Buffer; name: string; description: string }> }> {
    if (!historicData) {
        historicData = await getHistoricalData();
    }

    if (!historicData) {
        return { content: 'Great Vaults last week\nNo data available — check WoW Audit API is configured.', files: [] };
    }

    const greatVault = historicData.map((character) => ({
        characterName: character.name,
        greatVault: character.data?.vault_options ?? null,
    }));

    greatVault.sort((a, b) =>
        a.characterName.toUpperCase() < b.characterName.toUpperCase() ? -1
            : a.characterName.toUpperCase() > b.characterName.toUpperCase() ? 1 : 0,
    );

    const longestName = greatVault.reduce(
        (max, c) => Math.max(max, c.characterName.length), 0,
    );

    let content = '';
    content += `${padRight('', longestName)}| ${padRight('Raid', 16)} | ${padRight('Dungeon', 16)} | ${padRight('World', 16)}\n`;
    content += '-'.repeat(content.length) + '\n';

    for (const character of greatVault) {
        const raids = character.greatVault?.raids ?? null;
        const dungeons = character.greatVault?.dungeons ?? null;
        const world = character.greatVault?.world ?? null;

        const raidOptions = raids === null ? 'No Data         '
            : `${padRight(raids.option_1 ?? '', 4)}/ ${padRight(raids.option_2 ?? '', 4)}/ ${padRight(raids.option_3 ?? '', 4)}`;
        const dungeonOptions = dungeons === null ? 'No Data         '
            : `${padRight(dungeons.option_1 ?? '', 4)}/ ${padRight(dungeons.option_2 ?? '', 4)}/ ${padRight(dungeons.option_3 ?? '', 4)}`;
        const worldOptions = world === null ? 'No Data         '
            : `${padRight(world.option_1 ?? '', 4)}/ ${padRight(world.option_2 ?? '', 4)}/ ${padRight(world.option_3 ?? '', 4)}`;

        content += `${padRight(character.characterName, longestName)}| ${padRight(raidOptions, 16)} | ${padRight(dungeonOptions, 16)} | ${padRight(worldOptions, 16)}\n`;
    }

    const buffer = Buffer.from(content, 'utf-8');
    const today = new Date().toISOString().split('T')[0];

    return {
        content: 'Great Vaults last week',
        files: [{
            attachment: buffer,
            name: `great_vaults_${today}.txt`,
            description: 'Raiders Great Vaults last week',
        }],
    };
}

/**
 * Send both weekly reports (M+ and Great Vault) to the weekly_check channel.
 */
export async function alertHighestMythicPlusDone(client: Client): Promise<void> {
    const channelId = getChannel('weekly_check');
    if (!channelId) return;

    const channel = await client.channels.fetch(channelId);
    const sendable = asSendable(channel);
    if (!sendable) return;

    const textChannel = sendable as TextChannel;
    const data = await getHistoricalData();

    const mythicPlusMessage = await getPreviousWeekMythicPlusMessage(data);
    await textChannel.send(mythicPlusMessage);

    const greatVaultMessage = await getPreviousWeeklyGreatVaultMessage(data);
    await textChannel.send(greatVaultMessage);

    await logger.info('[Raiders] Sent weekly M+ and Great Vault reports');
}

function padRight(value: string | null, length: number): string {
    const str = (value ?? '').toString();
    const spacesNeeded = Math.max(0, length - str.length);
    return str + ' '.repeat(spacesNeeded);
}

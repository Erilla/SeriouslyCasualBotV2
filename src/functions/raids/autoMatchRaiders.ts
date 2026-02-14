import type { Client, GuildMember } from 'discord.js';
import { config } from '../../config.js';
import { getDatabase } from '../../database/database.js';
import { getChannel } from '../setup/getChannel.js';
import { updateRaiderDiscordUser } from './updateRaiderDiscordUser.js';
import { logger } from '../../services/logger.js';
import type { RaiderRow } from '../../types/index.js';

export interface AutoMatchResult {
    matched: Array<{ characterName: string; discordUserId: string }>;
    unmatched: string[];
}

/**
 * Attempt to auto-match unmatched raiders to Discord guild members with the raider role.
 * Matching is case-insensitive exact match against member nickname, displayName, and username.
 * Only links when exactly ONE member matches a character name.
 *
 * Returns early (no action) if raider role is not configured.
 */
export async function autoMatchRaiders(client: Client): Promise<AutoMatchResult> {
    const db = getDatabase();

    // Get all unmatched raiders
    const unmatchedRows = db.prepare(
        'SELECT character_name FROM raiders WHERE discord_user_id IS NULL',
    ).all() as Pick<RaiderRow, 'character_name'>[];

    if (unmatchedRows.length === 0) {
        return { matched: [], unmatched: [] };
    }

    const unmatchedNames = unmatchedRows.map((r) => r.character_name);

    // Raider role must be configured
    const raiderRoleId = getChannel('raider_role');
    if (!raiderRoleId) {
        await logger.debug('[Raiders] Auto-match skipped: raider_role not configured');
        return { matched: [], unmatched: unmatchedNames };
    }

    // Fetch all guild members
    const guild = await client.guilds.fetch(config.guildId);
    await guild.members.fetch();

    // Filter to members with the raider role
    const membersWithRole = guild.members.cache.filter(
        (m) => m.roles.cache.has(raiderRoleId),
    );
    await logger.debug(`[Raiders] Auto-match: ${unmatchedNames.length} unmatched raiders, ${membersWithRole.size} members with raider role`);

    // Get discord user IDs already assigned to any raider
    const assignedRows = db.prepare(
        'SELECT discord_user_id FROM raiders WHERE discord_user_id IS NOT NULL',
    ).all() as Pick<RaiderRow, 'discord_user_id'>[];
    const assignedUserIds = new Set(assignedRows.map((r) => r.discord_user_id));

    // Filter to members not already assigned
    const availableMembers = new Map<string, GuildMember>();
    for (const [id, member] of membersWithRole) {
        if (!assignedUserIds.has(id)) {
            availableMembers.set(id, member);
        }
    }
    await logger.debug(`[Raiders] Auto-match: ${availableMembers.size} available members (not already assigned)`);

    const matched: AutoMatchResult['matched'] = [];
    const unmatched: string[] = [];

    for (const characterName of unmatchedNames) {
        const charLower = characterName.toLowerCase();

        // Find all available members that match this character name
        const matches: GuildMember[] = [];
        for (const [, member] of availableMembers) {
            if (
                member.nickname?.toLowerCase() === charLower
                || member.user.displayName.toLowerCase() === charLower
                || member.user.username.toLowerCase() === charLower
            ) {
                matches.push(member);
            }
        }

        if (matches.length === 1) {
            const member = matches[0];
            updateRaiderDiscordUser(characterName, member.id);
            matched.push({ characterName, discordUserId: member.id });
            // Remove from available pool to prevent double-assignment
            availableMembers.delete(member.id);
            await logger.info(`[Raiders] Auto-linked "${characterName}" to ${member.user.tag} (${member.id})`);
        } else {
            unmatched.push(characterName);
        }
    }

    if (matched.length > 0 || unmatched.length > 0) {
        await logger.debug(
            `[Raiders] Auto-match: ${matched.length} linked, ${unmatched.length} unmatched`,
        );
    }

    return { matched, unmatched };
}

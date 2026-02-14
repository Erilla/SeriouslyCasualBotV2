import type { Client, GuildMember } from 'discord.js';
import { config } from '../../config.js';
import { getDatabase } from '../../database/database.js';
import { getChannel } from '../setup/getChannel.js';
import { logger } from '../../services/logger.js';
import type { RaiderRow } from '../../types/index.js';

export interface AutoMatchResult {
    matched: Array<{ characterName: string; discordUserId: string }>;
    unmatched: string[];
}

/**
 * Build a name→members index from available members for O(1) lookups.
 * Maps lowercase nickname, displayName, and username to member arrays.
 */
function buildNameIndex(members: Map<string, GuildMember>): Map<string, GuildMember[]> {
    const index = new Map<string, GuildMember[]>();
    for (const [, member] of members) {
        const names = new Set<string>();
        if (member.nickname) names.add(member.nickname.toLowerCase());
        names.add(member.user.displayName.toLowerCase());
        names.add(member.user.username.toLowerCase());

        for (const name of names) {
            const existing = index.get(name);
            if (existing) {
                existing.push(member);
            } else {
                index.set(name, [member]);
            }
        }
    }
    return index;
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

    // Single query: get all raiders, partition in JS
    const allRows = db.prepare(
        'SELECT character_name, discord_user_id FROM raiders',
    ).all() as Pick<RaiderRow, 'character_name' | 'discord_user_id'>[];

    const unmatchedNames: string[] = [];
    const assignedUserIds = new Set<string>();
    for (const row of allRows) {
        if (row.discord_user_id == null) {
            unmatchedNames.push(row.character_name);
        } else {
            assignedUserIds.add(row.discord_user_id);
        }
    }

    if (unmatchedNames.length === 0) {
        return { matched: [], unmatched: [] };
    }

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

    // Filter to members not already assigned
    const availableMembers = new Map<string, GuildMember>();
    for (const [id, member] of membersWithRole) {
        if (!assignedUserIds.has(id)) {
            availableMembers.set(id, member);
        }
    }
    await logger.debug(`[Raiders] Auto-match: ${availableMembers.size} available members (not already assigned)`);

    // Build name index for O(1) lookups
    const nameIndex = buildNameIndex(availableMembers);

    const matched: AutoMatchResult['matched'] = [];
    const unmatched: string[] = [];

    for (const characterName of unmatchedNames) {
        const charLower = characterName.toLowerCase();
        const matches = nameIndex.get(charLower) ?? [];

        // Filter out members already matched in this run
        const available = matches.filter((m) => availableMembers.has(m.id));

        if (available.length === 1) {
            const member = available[0];
            matched.push({ characterName, discordUserId: member.id });
            // Remove from available pool to prevent double-assignment
            availableMembers.delete(member.id);
            await logger.info(`[Raiders] Auto-linked "${characterName}" to ${member.user.tag} (${member.id})`);
        } else {
            unmatched.push(characterName);
        }
    }

    // Batch all DB updates in a single transaction
    if (matched.length > 0) {
        const updateStmt = db.prepare(
            'UPDATE raiders SET discord_user_id = ? WHERE LOWER(character_name) = LOWER(?)',
        );
        const batchUpdate = db.transaction(() => {
            for (const { characterName, discordUserId } of matched) {
                updateStmt.run(discordUserId, characterName);
            }
        });
        batchUpdate();
    }

    if (matched.length > 0 || unmatched.length > 0) {
        await logger.debug(
            `[Raiders] Auto-match: ${matched.length} linked, ${unmatched.length} unmatched`,
        );
    }

    return { matched, unmatched };
}

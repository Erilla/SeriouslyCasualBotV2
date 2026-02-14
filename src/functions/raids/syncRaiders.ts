import type { Client } from 'discord.js';
import { getDatabase } from '../../database/database.js';
import { getGuildRoster } from '../../services/raiderio.js';
import { fetchTextChannel } from '../../utils.js';
import { logger } from '../../services/logger.js';
import { getStoredIgnoredCharacters } from './ignoreCharacter.js';
import { sendAlertForRaidersWithNoUser } from './sendAlertForRaidersWithNoUser.js';
import { autoMatchRaiders } from './autoMatchRaiders.js';
import { sendAutoMatchAlerts } from './sendAutoMatchAlerts.js';
import type { RaiderRow } from '../../types/index.js';

/**
 * Sync the raiders table with the current guild roster from Raider.io.
 * - Removes raiders no longer in the guild
 * - Adds new raiders from the roster
 * - Updates realm info
 * - Alerts for new raiders with no Discord user
 * - Posts summary to bot_setup channel
 */
export async function syncRaiders(client: Client): Promise<void> {
    const db = getDatabase();

    const storedRaiders = db.prepare('SELECT * FROM raiders').all() as RaiderRow[];
    const storedNamesLower = new Set(storedRaiders.map((r) => r.character_name.toLowerCase()));

    const ignoredCharacters = getStoredIgnoredCharacters();
    const ignoredLower = new Set(ignoredCharacters.map((n) => n.toLowerCase()));

    const wholeRoster = await getGuildRoster();
    if (wholeRoster.length === 0) {
        await logger.warn('[Raiders] Guild roster returned empty, skipping sync');
        return;
    }

    // Filter out ignored characters
    const guildRoster = wholeRoster.filter(
        (m) => !ignoredLower.has(m.character.name.toLowerCase()),
    );
    const rosterNamesLower = new Set(guildRoster.map((m) => m.character.name.toLowerCase()));

    let summaryMessage = '';

    // Remove raiders no longer in guild (or now ignored)
    const toRemove = storedRaiders.filter(
        (r) => !rosterNamesLower.has(r.character_name.toLowerCase()) || ignoredLower.has(r.character_name.toLowerCase()),
    );
    if (toRemove.length > 0) {
        const removeStmt = db.prepare('DELETE FROM raiders WHERE id = ?');
        const removeMany = db.transaction((raiders: RaiderRow[]) => {
            for (const r of raiders) removeStmt.run(r.id);
        });
        removeMany(toRemove);

        summaryMessage += '**Removed raiders:**\n';
        summaryMessage += toRemove.map((r) => r.character_name).join('\n');
        summaryMessage += '\n\n';
    }

    // Add new raiders
    const toAdd = guildRoster.filter(
        (m) => !storedNamesLower.has(m.character.name.toLowerCase()),
    );
    if (toAdd.length > 0) {
        const insertStmt = db.prepare(
            'INSERT INTO raiders (character_name, realm, region) VALUES (?, ?, ?)',
        );
        const insertMany = db.transaction((members: typeof toAdd) => {
            for (const m of members) {
                insertStmt.run(m.character.name, m.character.realm, m.character.region);
            }
        });
        insertMany(toAdd);

        summaryMessage += '**Added raiders:**\n';
        summaryMessage += toAdd.map((m) => m.character.name).join('\n');
        summaryMessage += '\n\n';
    }

    // Auto-match all unmatched raiders to Discord members with raider role
    try {
        const autoMatchResult = await autoMatchRaiders(client);

        if (autoMatchResult.matched.length > 0) {
            await sendAutoMatchAlerts(client, autoMatchResult.matched);
        }

        if (autoMatchResult.unmatched.length > 0) {
            await sendAlertForRaidersWithNoUser(client, autoMatchResult.unmatched);
        }
    } catch (error) {
        await logger.warn(`[Raiders] Auto-match failed, falling back to manual: ${error}`);
        // Fall back to manual alerts for all unmatched
        const unmatchedRows = db.prepare(
            'SELECT character_name FROM raiders WHERE discord_user_id IS NULL',
        ).all() as Pick<RaiderRow, 'character_name'>[];
        if (unmatchedRows.length > 0) {
            await sendAlertForRaidersWithNoUser(client, unmatchedRows.map((r) => r.character_name));
        }
    }

    // Update realm/region for existing raiders that may have changed
    const updateStmt = db.prepare(
        'UPDATE raiders SET realm = ?, region = ? WHERE LOWER(character_name) = LOWER(?)',
    );
    const updateMany = db.transaction((members: typeof guildRoster) => {
        for (const member of members) {
            if (storedNamesLower.has(member.character.name.toLowerCase())) {
                updateStmt.run(member.character.realm, member.character.region, member.character.name);
            }
        }
    });
    updateMany(guildRoster);

    // Post summary to bot_setup channel
    if (summaryMessage) {
        const textChannel = await fetchTextChannel(client, 'bot_setup');
        if (textChannel) {
            await textChannel.send(summaryMessage.trim());
        }
    }

    await logger.debug(
        `[Raiders] Sync complete: ${toRemove.length} removed, ${toAdd.length} added`,
    );
}

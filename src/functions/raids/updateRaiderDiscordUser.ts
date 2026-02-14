import { getDatabase } from '../../database/database.js';

/**
 * Update a raider's Discord user ID (case-insensitive character name match).
 */
export function updateRaiderDiscordUser(characterName: string, discordUserId: string): boolean {
    const db = getDatabase();
    const result = db.prepare(
        'UPDATE raiders SET discord_user_id = ? WHERE LOWER(character_name) = LOWER(?)',
    ).run(discordUserId, characterName);
    return result.changes > 0;
}

/**
 * Clear a raider's Discord user ID (unmatch).
 */
export function unmatchRaider(characterName: string): boolean {
    const db = getDatabase();
    const result = db.prepare(
        'UPDATE raiders SET discord_user_id = NULL WHERE LOWER(character_name) = LOWER(?)',
    ).run(characterName);
    return result.changes > 0;
}

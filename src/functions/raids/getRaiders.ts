import { getDatabase } from '../../database/database.js';
import type { RaiderRow } from '../../types/index.js';

/**
 * Get all stored raiders from the database.
 */
export function getStoredRaiders(): RaiderRow[] {
    const db = getDatabase();
    return db.prepare('SELECT * FROM raiders ORDER BY character_name COLLATE NOCASE').all() as RaiderRow[];
}

/**
 * Get a formatted string of all raiders for display.
 */
export function getRaidersFormatted(): string {
    const raiders = getStoredRaiders();
    if (raiders.length === 0) return 'No raiders found.';

    return raiders
        .map((r) => {
            const user = r.discord_user_id ? `<@${r.discord_user_id}>` : '*no user*';
            return `${r.character_name} (${r.realm ?? 'unknown'}) - ${user}`;
        })
        .join('\n');
}
